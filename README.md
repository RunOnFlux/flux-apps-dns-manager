# Flux Apps DNS Manager

Standalone DNS management service for Flux applications. Provides direct DNS routing for apps that need it (like game servers), allowing connections directly without going through HAProxy.

## Why This Service?

Certain applications (game servers like Minecraft, Rust, Valheim, etc.) need direct connections for:
- Lower latency
- UDP support (most games use UDP)
- Proper player authentication

This service runs separately from FDM to:
- Maintain separation of concerns
- Improve security isolation
- Prevent race conditions from multiple FDM instances

## Prerequisites

- Node.js 14+
- Access to DNS Gateway API (mTLS)
- Network access to Flux API

## Installation

```bash
npm install
```

## Configuration

Edit configuration files in `config/`:

1. **dnsGatewayConfig.js** - DNS Gateway credentials
```javascript
module.exports = {
  endpoint: 'https://dns-gateway.internal:8443',
  certPath: '/path/to/client.crt',
  keyPath: '/path/to/client.key',
  caPath: '/path/to/ca.crt',
  enabled: true,
};
```

2. **gamesConfig.js** - App types to manage
```javascript
module.exports = {
  gameTypes: ['minecraft', 'palworld', 'rustserver', ...],
};
```

## Running

```bash
# Development (with auto-reload)
npm run dev

# Production
npm start
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/status` | GET | Service status |
| `/dns-state` | GET | Current DNS records |
| `/trigger` | POST | Force processing loop |

## How It Works

1. Polls Flux API every 10 seconds for app specifications
2. Filters for G-mode apps matching configured app types
3. Selects master IP for each app (deterministic selection)
4. Updates DNS A records via DNS Gateway when IPs change
5. Deletes DNS records for removed apps after grace period (1 hour)

## License

AGPL-3.0-or-later
