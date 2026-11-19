"""Tasks waiting for agents, and the answers coming back. One backend process, kept in memory like runs.

An agent long-polls (POST /api/agent/poll). `call()` puts a task on that server's queue and waits for its
result; the agent streams output lines while it works (`event`) and ends with `finish`. A poll that finds
the queue empty waits up to POLL_WAIT seconds, so a new task reaches an idle agent at once.

A server counts as online while it is polling or polled in the last ONLINE seconds.
"""

from __future__ import annotations

import asyncio
import secrets
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

POLL_WAIT = 25.0
ONLINE = POLL_WAIT + 20.0


class AgentError(Exception):
    """The agent could not be reached, refused the task, or did not answer in time."""


@dataclass
class Task:
    id: str
    host_id: int
    op: dict[str, Any]
    on_line: Callable[[str], None] | None = None
    future: asyncio.Future = field(default_factory=lambda: asyncio.get_running_loop().create_future())
    sent: bool = False


class Hub:
    def __init__(self) -> None:
        self.queues: dict[int, asyncio.Queue[Task]] = {}
        self.tasks: dict[str, Task] = {}
        self.seen: dict[int, float] = {}
        self.polling: dict[int, int] = {}
        self.wakers: dict[int, asyncio.Event] = {}

    def _queue(self, host_id: int) -> asyncio.Queue[Task]:
        q = self.queues.get(host_id)
        if q is None:
            q = self.queues[host_id] = asyncio.Queue()
        return q

    # ----- presence -----

    def online(self, host_id: int, now: float | None = None) -> bool:
        now = time.time() if now is None else now
        return self.polling.get(host_id, 0) > 0 or now - self.seen.get(host_id, 0) < ONLINE

    async def wait_online(self, host_id: int, timeout: float) -> bool:
        if self.online(host_id):
            return True
        ev = self.wakers.setdefault(host_id, asyncio.Event())
        try:
            await asyncio.wait_for(ev.wait(), timeout)
        except asyncio.TimeoutError:
            pass
        return self.online(host_id)

    def touch(self, host_id: int) -> None:
        self.seen[host_id] = time.time()
        ev = self.wakers.pop(host_id, None)
        if ev:
            ev.set()

    # ----- the agent side -----

    async def next_task(self, host_id: int, wait: float) -> Task | None:
        self.touch(host_id)
        self.polling[host_id] = self.polling.get(host_id, 0) + 1
        try:
            q = self._queue(host_id)
            while True:
                try:
                    task = await asyncio.wait_for(q.get(), wait)
                except asyncio.TimeoutError:
                    return None
                if task.future.done():  # cancelled while queued
                    continue
                task.sent = True
                return task
        finally:
            self.polling[host_id] -= 1
            self.touch(host_id)

    def line(self, task_id: str, text: str) -> bool:
        task = self.tasks.get(task_id)
        if not task:
            return False
        if task.on_line:
            task.on_line(text)
        return True

    def finish(self, task_id: str, result: dict[str, Any]) -> bool:
        task = self.tasks.pop(task_id, None)
        if not task:
            return False
        if not task.future.done():
            task.future.set_result(result)
        return True

    def owner(self, task_id: str) -> int | None:
        task = self.tasks.get(task_id)
        return task.host_id if task else None

    # ----- the Wharfline side -----

    async def call(self, host_id: int, op: dict[str, Any], timeout: float, on_line: Callable[[str], None] | None = None) -> dict[str, Any]:
        """Send one task and wait for its result. Cancelling the caller asks the agent to stop the task."""
        task = Task(id=secrets.token_hex(12), host_id=host_id, op=op, on_line=on_line)
        self.tasks[task.id] = task
        self._queue(host_id).put_nowait(task)
        try:
            return await asyncio.wait_for(asyncio.shield(task.future), timeout)
        except asyncio.TimeoutError as e:
            self._cancel(task)
            raise AgentError(f"에이전트가 {int(timeout)}초 안에 답하지 않았어요") from e
        except asyncio.CancelledError:
            self._cancel(task)
            raise

    def _cancel(self, task: Task) -> None:
        self.tasks.pop(task.id, None)
        if not task.future.done():
            task.future.cancel()
        if task.sent:  # the agent is working on it: tell it to stop
            # Nobody waits for this one; it is not in self.tasks, so its finish is ignored.
            self._queue(task.host_id).put_nowait(Task(id=secrets.token_hex(12), host_id=task.host_id,
                                                      op={"op": "cancel", "task": task.id}))

    def kick(self, host_id: int) -> None:
        """Forget queued tasks for a server (it was removed or re-enrolled)."""
        q = self.queues.pop(host_id, None)
        while q and not q.empty():
            t = q.get_nowait()
            if not t.future.done():
                t.future.set_exception(AgentError("서버가 바뀌었어요"))


HUB = Hub()
