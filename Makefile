.PHONY: install install-hooks build test ci security-scan clean land

install:
	npm install
	cd cli && npm install

install-hooks:
	git config core.hooksPath .githooks
	chmod +x .githooks/pre-commit .githooks/pre-push .githooks/pre-commit.local .githooks/pre-push.local .githooks/.security-pipeline-baseline 2>/dev/null || true
	@echo "✓ Git hooks installed via .githooks"

build:
	cd cli && npm run build

test:
	cd cli && npm test

ci: install build test
	@echo "✓ CI passed"

security-scan:
	./scripts/security-scan.sh

clean:
	rm -rf node_modules cli/node_modules cli/dist

# Land the current branch: push, open a PR if needed, arm squash
# auto-merge. Squash is mandatory, not a preference: the main branch
# protection enforces linear history, so a merge-commit auto-merge
# arms successfully and then never fires. Never --merge here.
land:
	@branch=$$(git branch --show-current); \
	if [ "$$branch" = "main" ] || [ "$$branch" = "master" ] || [ -z "$$branch" ]; then echo "refusing to land '$$branch'"; exit 1; fi; \
	git push -u origin "$$branch"; \
	if ! gh pr view --json number -q .number >/dev/null 2>&1; then \
		gh pr create --fill; \
	fi; \
	gh pr merge --squash --auto
	@echo "PR armed (squash auto-merge, linear-history gate)"
