# VyOS Config Viewer API

Web application for viewing and managing VyOS router configurations via REST API.

![Python](https://img.shields.io/badge/python-3.8+-blue.svg)
![Flask](https://img.shields.io/badge/flask-2.2+-green.svg)
![VyOS](https://img.shields.io/badge/VyOS-1.4+-orange.svg)

## Features

- **View Configuration**: Browse firewall rulesets, NAT rules, and firewall groups
- **CRUD Operations**: Create, modify, and delete firewall and NAT rules
- **Staged Mode**: Queue multiple changes and apply them in a single batch
- **Verbose Mode**: Preview VyOS commands before execution
- **Differential Updates**: Only send changed fields when editing rules
- **Activity Log**: Track all operations performed during the session
- **NAT Exclude**: Support for VPN/IPsec traffic bypass rules
- **All VyOS 1.4 Actions**: accept, drop, reject, return, continue, jump, queue
- **Group Support**: address-group, network-group, port-group
- **Draggable Modals**: Better UX for rule editing
- **Multiple Themes**: Light, dark, and retro themes

## Requirements

- Python 3.8+
- VyOS 1.4+ with HTTPS API enabled
- Modern web browser

## Installation

```bash
# Clone the repository
git clone https://github.com/darconada/vyos-config-api.git
cd vyos-config-api

# Install dependencies
pip install -r requirements.txt

# Run the application
python app.py
```

The server will start at `http://0.0.0.0:5000`

## VyOS Configuration

Enable the HTTPS API on your VyOS router:

### VyOS 1.4 (sagitta)
```vyos
configure
set service https port 8443
set service https api keys id viewer key 'your-api-key'
commit
save
```

### VyOS rolling/latest
```vyos
configure
set service https port 8443
set service https api keys id viewer key 'your-api-key'
set service https api rest
commit
save
```

### Optional: Restrict access by IP
```vyos
set service https allow-client address 192.168.1.0/24
```

## Usage

1. Open `http://localhost:5000` in your browser
2. Click **Connect** and enter:
   - Host: Your VyOS router IP
   - Port: 8443 (or your configured port)
   - API Key: The key configured in VyOS
3. Browse firewall rules and NAT configuration
4. Use **Edit** and **Delete** buttons to manage rules
5. Enable **Staged** mode to queue multiple changes before applying
6. Enable **Verbose** mode to preview commands before execution
7. Check the **Activity** section to review all operations
8. Click **Save** to persist changes to the router

## Screenshots

### Firewall Rules View
- View all firewall rulesets
- Expand groups inline
- Filter and search rules

### Rule Editor
- Create and edit firewall rules
- Support for all VyOS 1.4 actions
- Jump to other rulesets

### NAT Rules
- Destination NAT (port forwarding)
- Source NAT (masquerade)
- Exclude rules for VPN traffic

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/fetch-config` | Connect to VyOS router |
| POST | `/upload` | Upload JSON config file |
| GET | `/api/firewall/rulesets` | List firewall rulesets |
| GET | `/api/firewall/ruleset/<name>` | Get ruleset rules |
| POST | `/api/firewall/rule` | Create/modify firewall rule |
| DELETE | `/api/firewall/rule` | Delete firewall rule |
| GET | `/api/NAT` | Get NAT configuration |
| POST | `/api/nat/rule` | Create/modify NAT rule |
| DELETE | `/api/nat/rule` | Delete NAT rule |
| POST | `/api/save-config` | Save config to router |
| POST | `/api/batch-configure` | Apply multiple operations in batch |

## File Structure

```
vyos-config-api/
├── app.py              # Flask backend
├── vyos_api.py         # VyOS REST API client
├── requirements.txt    # Python dependencies
├── templates/
│   └── index.html      # Main HTML template
└── static/
    ├── app.js          # Frontend JavaScript
    ├── style.css       # Main styles
    └── modal.css       # Modal styles
```

## Security Notes

- The API key is sent over HTTPS
- Self-signed certificates are accepted by default
- Consider restricting API access by IP in VyOS
- Do not expose this application to the public internet

## License

MIT License

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
