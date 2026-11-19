# Wharfline agent. Runs on each server (see backend/app/agentinstall.py for the docker run line).
FROM docker:27.3.1-cli AS dockercli

FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

# nsenter (util-linux) runs tasks in the server's namespaces; openssh-client carries playbooks to 127.0.0.1;
# the docker CLI reads containers and updates the agent itself. Deploy commands use the server's own docker.
RUN apt-get update \
    && apt-get install -y --no-install-recommends util-linux openssh-client \
    && rm -rf /var/lib/apt/lists/*
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker

WORKDIR /agent
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY ansible-collections.yml .
RUN ansible-galaxy collection install -r ansible-collections.yml -p /usr/share/ansible/collections \
    && rm -rf /root/.ansible
COPY wharfline_agent.py .

ARG VERSION=dev
ENV WHARFLINE_AGENT_VERSION=${VERSION}
VOLUME /data
CMD ["python", "/agent/wharfline_agent.py"]
