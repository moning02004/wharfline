# Everyday commands on a production server (next to docker-compose.yml and .env).
# `make` or `make help` lists them.

COMPOSE := docker compose
VERSION  = $(shell sed -n 's/^WHARFLINE_VERSION=//p' .env 2>/dev/null)
IMAGE    = ghcr.io/moning02004/wharfline-backend:$(VERSION)
KEYS    := secrets/master_keys

.DEFAULT_GOAL := help
.PHONY: help up down restart ps logs upgrade keygen key-status key-verify key-rotate key-backup backup restore

help: ## List the commands
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*## "}{printf "  make %-12s %s\n", $$1, $$2}'

up: $(KEYS) ## Start (or apply .env changes)
	$(COMPOSE) up -d

down: ## Stop everything (data and certificates stay)
	$(COMPOSE) down

restart: ## Restart the app containers
	$(COMPOSE) restart backend frontend

ps: ## Container status
	$(COMPOSE) ps

logs: ## Follow logs, e.g. make logs s=backend
	$(COMPOSE) logs -f --tail 100 $(s)

upgrade: ## Back up, then run a new release: make upgrade v=2026.11.09-1
	@test -n "$(v)" || (echo 'usage: make upgrade v=<release tag>' && exit 1)
	$(MAKE) backup
	sed -i.bak 's/^WHARFLINE_VERSION=.*/WHARFLINE_VERSION=$(v)/' .env && rm -f .env.bak
	$(COMPOSE) pull
	$(COMPOSE) up -d

keygen: ## Create the master key once (refuses to overwrite)
	@test -n "$(VERSION)" || (echo 'set WHARFLINE_VERSION in .env first' && exit 1)
	@test ! -e $(KEYS) || (echo "$(KEYS) already exists; not overwriting" && exit 1)
	@mkdir -p secrets && chmod 700 secrets
	docker run --rm $(IMAGE) python -c 'from app.crypto import generate_key_line; import time; print(generate_key_line(time.strftime("k%Y%m%d%H%M%S")))' > $(KEYS)
	@chmod 644 $(KEYS)
	@echo "Created $(KEYS). Now run: make key-backup"

$(KEYS):
	@echo "$(KEYS) is missing. Run: make keygen" && exit 1

key-status: ## Which master key wraps the stored secrets
	$(COMPOSE) run --rm migrate python -m app.keys status

key-verify: ## Decrypt every stored secret to prove the key works
	$(COMPOSE) run --rm migrate python -m app.keys verify

key-rotate: ## Re-wrap all data keys with the first key in secrets/master_keys
	$(COMPOSE) run --rm migrate python -m app.keys rotate

key-backup: $(KEYS) ## Passphrase-encrypted copy of the master key in backups/ (store it off this server)
	@mkdir -p backups && chmod 700 backups
	openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -in $(KEYS) -out backups/master_keys-$$(date +%Y%m%d%H%M%S).enc
	@echo "Copy backups/master_keys-*.enc somewhere other than your DB backups."

backup: ## Database dump into backups/
	@mkdir -p backups && chmod 700 backups
	$(COMPOSE) exec -T db pg_dump -U wharfline -Fc wharfline > backups/wharfline-$$(date +%Y%m%d%H%M%S).dump
	@ls -1t backups/wharfline-*.dump | head -1

restore: ## Restore a dump: make restore f=backups/wharfline-....dump
	@test -n "$(f)" || (echo 'usage: make restore f=backups/wharfline-....dump' && exit 1)
	$(COMPOSE) stop backend frontend
	$(COMPOSE) exec -T db pg_restore -U wharfline -d wharfline --clean --if-exists < $(f)
	$(COMPOSE) up -d
