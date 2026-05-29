# 🎉 Charity Poll

Real-time live polling for charity events — a focused Mentimeter clone.  
Host creates questions, attendees vote on their phones, results update live on a projector.

---

## Pages

| URL | Purpose |
|---|---|
| `/admin` | Host control panel (password-protected) |
| `/join` or `/join?code=XXXXXX` | Attendee voting page (mobile-first) |
| `/present` | Big-screen live results for the projector |

---

## Quick Start

```bash
# 1. Install dependencies
cd charity-poll
npm install

# 2. Copy and edit config
cp .env.example .env
# Edit .env: set ADMIN_PASSWORD and EVENT_NAME at minimum

# 3. Run
npm start

# Development (auto-restarts on save — Node 18+)
npm run dev
```

Open `http://localhost:3000/admin` and log in with your admin password.  
The room code and QR code are shown on that page.

---

## Configuration

All event settings live in `.env` (copy from `.env.example`):

```dotenv
# Server
PORT=3000
BASE_URL=https://your-public-domain.com   # Used for QR code links

# Admin
ADMIN_PASSWORD=charity2026

# Branding
EVENT_NAME=Hope Gala 2026
EVENT_TAGLINE=Together we make a difference
LOGO_URL=                     # Leave blank or set to a public image URL

# Theme colors (hex)
PRIMARY_COLOR=#e85d04
ACCENT_COLOR=#f48c06
BG_COLOR=#fff8f0
DARK_COLOR=#2d3250
```

**All pages pick up theme colors dynamically** — just restart the server after editing.

---

## Data Persistence

Results are persisted to `session.json` (or the path in `SESSION_PATH`).  
A server restart will reload existing votes — nothing is lost mid-event.

To reset everything (new event):

```bash
rm session.json
npm start
```

---

## Swapping the Storage Layer

The entire data layer is isolated in `store.js`. Every read/write goes through the  
`Store` class methods. To use SQLite instead:

1. Replace the `_load` / `_save` methods with SQLite queries  
2. Keep all public method signatures identical  
3. `server.js` needs zero changes

---

## Deploying

### Render / Railway (simplest)

1. Push to a GitHub repo
2. Create a new **Web Service** pointing to that repo
3. Set the environment variables in the dashboard (copy from `.env.example`)
4. Set **Start Command** to `npm start`
5. Set `BASE_URL` to your Render/Railway public URL so the QR code works

Both platforms provide free SSL and auto-deploy on push.

### Small VPS (Ubuntu)

```bash
# Install Node 18+
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# Clone + install
git clone <repo-url> charity-poll && cd charity-poll
npm install --production

# Set env vars (or use a .env file)
export ADMIN_PASSWORD=mySecurePassword
export BASE_URL=https://poll.myevent.org
export PORT=3000

# Run with pm2 for auto-restart
npm install -g pm2
pm2 start server.js --name charity-poll
pm2 save && pm2 startup

# Nginx reverse proxy (optional, for SSL + port 80/443)
# Point /etc/nginx/sites-available/poll to proxy_pass http://localhost:3000;
```

---

## Usage Guide

### Before the event
1. Go to `/admin`, log in
2. Add / edit / reorder your questions using the **Questions** panel
3. Share the QR code or room code with attendees in advance (optional)

### During the event
1. Project `/present` on the big screen — it shows live results
2. Attendees scan the QR code or go to `/join` and enter the room code
3. Click **▶ Activate** on the first question (or use **Next →**)
4. Watch votes roll in live
5. Use **🔒 Lock** to close voting before revealing results
6. Press **Next →** to advance — the attendee screens switch automatically
7. **↺ Reset** clears votes for a question if you want to re-run it

### Keyboard shortcuts (Admin panel)
- `→` — Next question  
- `←` — Previous question

---

## Sample Questions (Seeded)

The app ships with three charity-themed questions ready to go:

1. *Which cause should receive the largest share of tonight's donations?*  
   Options: Food Bank & Nutrition · Emergency Shelter · Mental Health Support · Youth Education

2. *How did you first hear about our charity?*  
   Options: Friend or Family · Social Media · Local News · I've Volunteered Before

3. *Which initiative are you most excited to support this year?*  
   Options: Community Kitchen · After-School Programs · Crisis Hotline · Clean Water Project · Winter Warmth Drive

Delete or edit them from the Admin panel before your event.

---

## Tech Stack

- **Backend**: Node.js + Express
- **Real-time**: Socket.IO (WebSockets)
- **Frontend**: Plain HTML / CSS / Vanilla JS (no build step)
- **Charts**: Chart.js 4 (CDN)
- **QR codes**: `qrcode` npm package (server-side)
- **Storage**: In-memory + JSON file persistence
