# Stratos Discord server

`setup.mjs` builds the server described in `server.mjs`: 8 roles, 7 categories,
25 channels with their permissions, and the welcome, rules and roles posts.

## Set it up (about 5 minutes)

1. **Create the server.** In Discord: **+** → *Create My Own* → *For a club or community*. Name it **Stratos**.
2. **Turn on Community** (for the forum channels): Server Settings → *Enable Community*.
3. **Create a bot.** https://discord.com/developers/applications → *New Application* → **Bot** → *Reset Token* and copy it.
4. **Invite the bot** with Administrator: *OAuth2* → *URL Generator* → scope `bot`, permission `Administrator` → open the URL and pick the Stratos server.
5. **Copy the server ID:** User Settings → Advanced → *Developer Mode* on, then right-click the server → *Copy Server ID*.
6. **Run the script** in PowerShell from the repository folder:

   ```powershell
   $env:DISCORD_TOKEN = 'paste-the-bot-token'; node community/discord/setup.mjs YOUR_SERVER_ID
   ```

7. **Finish up:** delete Discord's default `#general` and voice channels if you like, give yourself the **Admin** role, then remove the bot (or reset its token).

Preview without touching Discord: `node community/discord/setup.mjs --dry-run`

Running it again is safe: anything that already exists by name is kept.

## Layout

| Category | Channels |
|---|---|
| 📢 Start here | welcome, rules, announcements, releases, roles (read-only) |
| 💬 Community | general, screenshots, flight-logs, group-flights, aviation, off-topic |
| 🛠 Support | help, bug-reports, feature-requests (forums with tags), bridge-setup |
| ✈ Simulators | x-plane, msfs, efb-and-charts, vatsim-ivao |
| 🧪 Beta | beta-chat, beta-feedback (Beta Tester, Developer, staff) |
| 🔊 Voice | Flight Deck, Group Flight, Support Call |
| 🔒 Staff | staff-chat, mod-log (Admin, Moderator) |

Roles: Admin, Moderator, Developer, Beta Tester, X-Plane, MSFS, VATSIM, IVAO.

Never commit the bot token or paste it in a channel.
