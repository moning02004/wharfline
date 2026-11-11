FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

# The deploy runner clones playbook repos (git) and runs ansible-playbook, which logs in with OpenSSH
# (sshpass: playbook jobs that log in with a password).
RUN apt-get update \
    && apt-get install -y --no-install-recommends git openssh-client sshpass \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY alembic.ini ./
COPY migrations ./migrations
COPY app ./app
# Wharfline's built-in playbooks (store.BUILTIN_URL)
COPY playbooks/builtin /var/lib/wharfline/playbooks/builtin

# Run as an unprivileged user
RUN useradd --create-home --uid 10001 wharf
USER wharf

EXPOSE 8000

HEALTHCHECK --interval=10s --timeout=3s --retries=5 --start-period=20s \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/healthz')" || exit 1

# Migrations run separately (`python -m app.prestart`, the compose `migrate` service).
# The API refuses to start if the DB is behind or the master key is missing.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
