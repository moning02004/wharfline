# Everyday commands. Run `make` to list them.
#
# Migration, key and test commands run in a one-off `migrate` container with ./backend
# mounted, so new files land in the repo and nothing needs installing locally.

COMPOSE := docker compose
DEV     := $(COMPOSE) -f docker-compose.yml -f docker-compose.dev.yml
# One-off container: source mounted, master key secret attached, talks to the compose db.
RUN     := $(COMPOSE) run --rm -v $(CURDIR)/backend:/app migrate
ALEMBIC := $(RUN) alembic
KEYS    := secrets/master_keys

.DEFAULT_GOAL := help
.PHONY: help up down build logs ps restart db-up db-shell db-reset \
        migrate downgrade revision history current check sql seed \
        keygen key-status key-verify key-rotate key-backup key-restore kms-up kms-down kms-status test

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

# ---------- stack ----------

up: $(KEYS) ## Build and start everything (http://localhost:8080)
	$(COMPOSE) up -d --build

down: ## Stop everything (data is kept)
	$(COMPOSE) down

build: ## Rebuild images
	$(COMPOSE) build

logs: ## Follow backend logs
	$(COMPOSE) logs -f backend

ps: ## Show service status
	$(COMPOSE) ps

restart: ## Re-run migrations, then restart the backend
	$(COMPOSE) up -d --force-recreate migrate backend

# ---------- database ----------

db-up: $(KEYS) ## Start only Postgres, exposed on localhost:55432 for local dev
	$(DEV) up -d db

db-shell: ## Open psql
	$(COMPOSE) exec db psql -U wharfline -d wharfline

db-reset: $(KEYS) ## Delete all data and start fresh with sample data
	$(COMPOSE) down -v
	$(COMPOSE) up -d --build

seed: ## Load sample data into an empty database
	$(COMPOSE) run --rm migrate

# ---------- migrations ----------

migrate: ## Apply all pending migrations
	$(ALEMBIC) upgrade head

downgrade: ## Roll back one migration
	$(ALEMBIC) downgrade -1

revision: ## Create a migration from model changes: make revision m="add column x"
	@test -n "$(m)" || (echo 'usage: make revision m="describe the change"' && exit 1)
	$(ALEMBIC) revision --autogenerate -m "$(m)"
	@echo "Review the new file in backend/migrations/versions before committing."

history: ## List migrations
	$(ALEMBIC) history --verbose

current: ## Show the revision the database is on
	$(ALEMBIC) current

check: ## Fail if models and migrations are out of sync
	$(ALEMBIC) check

sql: ## Print the SQL for all migrations without running it
	$(ALEMBIC) upgrade head --sql

# ---------- master keys (envelope encryption) ----------

$(KEYS):
	@mkdir -p secrets && chmod 700 secrets
	@printf '%s:%s\n' "k$$(date -u +%Y%m%d%H%M%S)" "$$(openssl rand -base64 32)" > $(KEYS)
	@chmod 644 $(KEYS)   # readable by the container user; the 700 directory keeps other host users out
	@echo "Created $(KEYS). Back it up somewhere safe: without it the encrypted data cannot be read."

keygen: $(KEYS) ## Create the master key file if it does not exist

key-status: ## Show which master key each encrypted row uses
	$(RUN) python -m app.keys status

key-verify: ## Decrypt every encrypted row to prove the loaded keys work
	$(RUN) python -m app.keys verify

key-rotate: $(KEYS) ## Add a new master key, re-wrap all data keys with it, restart the API
	@{ printf '%s:%s\n' "k$$(date -u +%Y%m%d%H%M%S)" "$$(openssl rand -base64 32)"; cat $(KEYS); } > $(KEYS).new
	@chmod 644 $(KEYS).new && mv $(KEYS).new $(KEYS)
	$(RUN) python -m app.keys rotate
	$(COMPOSE) up -d --force-recreate backend
	$(RUN) python -m app.keys status
	@echo "Once status shows only the new key, delete the old lines from $(KEYS) (keep a backup)."

key-backup: $(KEYS) ## Write a passphrase-protected backup of the master keys
	@mkdir -p backups
	@out=backups/master_keys-$$(date -u +%Y%m%d%H%M%S).enc; \
	openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt -in $(KEYS) -out $$out && chmod 600 $$out && \
	echo "Wrote $$out. Store it away from the DB backups, and the passphrase somewhere else again."

key-restore: ## Restore master keys from a backup: make key-restore f=backups/master_keys-....enc
	@test -n "$(f)" || (echo 'usage: make key-restore f=backups/master_keys-....enc' && exit 1)
	@test ! -e $(KEYS) || (echo "$(KEYS) exists; move it away first" && exit 1)
	@mkdir -p secrets && chmod 700 secrets
	openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -in $(f) -out $(KEYS) && chmod 644 $(KEYS)

# ---------- KMS (OpenBao / Vault Transit) ----------

KMS := $(COMPOSE) -f docker-compose.yml -f docker-compose.kms.yml

secrets/vault_token:
	@mkdir -p secrets && chmod 700 secrets
	@echo dev-root > secrets/vault_token && chmod 644 secrets/vault_token
	@echo "Created secrets/vault_token with the OpenBao DEV root token. Use a least-privilege token in production."

kms-up: $(KEYS) secrets/vault_token ## Start with the master key in OpenBao (dev mode) and move all data keys onto it
	$(KMS) up -d --build openbao db
	$(KMS) run --rm migrate python -m app.keys vault-setup
	$(KMS) up -d --build
	$(KMS) run --rm migrate python -m app.keys rotate
	$(KMS) run --rm migrate python -m app.keys status

kms-down: $(KEYS) ## Move all data keys back to the local key file, then stop OpenBao
	$(KMS) run --rm -e WHARFLINE_KMS=vault-decrypt migrate python -m app.keys rotate
	@# Safety: every row must decrypt with the local key alone before OpenBao goes away.
	@# (Dev-mode OpenBao keeps its key in memory; removing it too early loses the data.)
	$(RUN) python -m app.keys verify
	$(COMPOSE) up -d --force-recreate backend
	$(KMS) stop openbao
	$(KMS) rm -f openbao
	$(RUN) python -m app.keys status

kms-status: ## Key status when running with the KMS overlay
	$(KMS) run --rm migrate python -m app.keys status

# ---------- tests ----------

test: ## Run backend tests
	$(RUN) sh -c "pip install -q --user --disable-pip-version-check -r requirements-dev.txt && python -m pytest -q"
