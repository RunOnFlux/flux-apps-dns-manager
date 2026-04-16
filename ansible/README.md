# Flux Apps DNS Manager - Ansible Deployment

This directory contains the Ansible playbook to deploy the Flux Apps DNS Manager service.

## Prerequisites

1. **SSH access** to the target host (flux-cert-1 at 10.100.0.172)
2. **mTLS certificates** must be deployed first via flux-fdm-infrastructure
   - Run the certificate deployment from flux-fdm-infrastructure before deploying this service
3. **Ansible** installed on your local machine

## Certificate Deployment (First Time Setup)

Before deploying this service, deploy the mTLS certificates:

```bash
cd ~/code/flux/flux-fdm-infrastructure/ansible
ansible-playbook -i inventory/hosts.yaml playbooks/apps-dns-manager/deploy_certs.yaml
```

This deploys certificates to:
- `/etc/ssl/certs/flux-apps-dns-manager/client.pem`
- `/etc/ssl/certs/flux-apps-dns-manager/dns-gateway-ca.pem`
- `/etc/ssl/private/flux-apps-dns-manager/client.key`

## Service Deployment

From this directory, you **must** provide DNS Gateway configuration via `-e` flags:

```bash
ansible-playbook -i inventory.yaml deploy.yaml \
  --private-key ~/.ssh/your-key \
  -e dns_gateway_endpoint="https://dns-gateway-host:port" \
  -e dns_gateway_cert_path="/path/to/client.pem" \
  -e dns_gateway_key_path="/path/to/client.key" \
  -e dns_gateway_ca_path="/path/to/ca.pem" \
  -e dns_gateway_enabled="true"
```

All DNS Gateway configuration variables default to empty/disabled and must be explicitly set.

## What Gets Deployed

- **Node.js 20.x** (via NodeSource repository)
- **Application code** to `/opt/flux-apps-dns-manager/`
- **System user** `apps-dns-manager`
- **Systemd service** `flux-apps-dns-manager`
- **NPM dependencies** (production only)

## Service Management

Once deployed:

```bash
# Check status
sudo systemctl status flux-apps-dns-manager

# View logs
sudo journalctl -u flux-apps-dns-manager -f

# Restart service
sudo systemctl restart flux-apps-dns-manager

# Stop service
sudo systemctl stop flux-apps-dns-manager
```

## Configuration

The DNS Gateway configuration (`config/dnsGatewayConfig.js`) is templated during Ansible deployment using Jinja2.

The config file remains generic in the repository with empty defaults. During deployment, Ansible generates the actual config file with values from Ansible variables.

## Updating the Service

To update the service with new code:

```bash
ansible-playbook -i inventory.yaml deploy.yaml
```

The playbook will:
1. Rsync new code
2. Reinstall npm dependencies if package.json changed
3. Restart the service

## Troubleshooting

### Service won't start
```bash
sudo journalctl -u flux-apps-dns-manager -n 50
```

### Certificate errors
Verify certificates exist and have correct permissions:
```bash
ls -la /etc/ssl/certs/flux-apps-dns-manager/
ls -la /etc/ssl/private/flux-apps-dns-manager/
```

### Can't connect to DNS Gateway
```bash
# Test DNS Gateway is accessible
curl -k https://10.100.0.172:8443/health
```
