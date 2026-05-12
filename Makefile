.PHONY: install install-hooks build test ci security-scan clean

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
