#!/bin/sh
set -e

# Template the Alertmanager config at boot. Exactly four placeholders are
# substituted via sed before the binary starts.
sed -i "s|__ALERTMANAGER_PORT__|${ALERTMANAGER_PORT}|g" /etc/alertmanager/alertmanager.yml
sed -i "s|__SLACK_API_URL__|${SLACK_API_URL}|g" /etc/alertmanager/alertmanager.yml
sed -i "s|__SMTP_HOST__|${SMTP_HOST}|g" /etc/alertmanager/alertmanager.yml
sed -i "s|__RECEIVER__|${RECEIVER}|g" /etc/alertmanager/alertmanager.yml

exec /bin/alertmanager --config.file=/etc/alertmanager/alertmanager.yml
