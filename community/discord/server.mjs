/* The Stratos Discord server: roles, channels and the first posts.
   Edit this file to change the layout; setup.mjs applies it. */

export const ROLES = [
  { name: '👑 Admin', color: 0xe11d48, hoist: true, perms: ['ADMINISTRATOR'] },
  { name: '🛡️ Moderator', color: 0xf59e0b, hoist: true, perms: ['KICK_MEMBERS', 'BAN_MEMBERS', 'MANAGE_MESSAGES', 'MANAGE_THREADS', 'MODERATE_MEMBERS', 'VIEW_AUDIT_LOG', 'MANAGE_NICKNAMES'] },
  { name: '🛠️ Developer', color: 0x8b5cf6, hoist: true, perms: [] },
  { name: '🧪 Beta Tester', color: 0x22d3ee, hoist: true, perms: [] },
  { name: '🛩️ X-Plane', color: 0x3b82f6, hoist: false, perms: [] },
  { name: '✈️ MSFS', color: 0x10b981, hoist: false, perms: [] },
  { name: '📡 VATSIM', color: 0x0ea5e9, hoist: false, perms: [] },
  { name: '📻 IVAO', color: 0x6366f1, hoist: false, perms: [] },
];

/* Which role names the permission levels use (setup.mjs reads these). */
export const STAFF = ['👑 Admin', '🛡️ Moderator'];
export const BETA = ['🧪 Beta Tester', '🛠️ Developer'];

/* access: 'public' (everyone talks), 'readonly' (staff post, everyone reads),
   'beta' (Beta Tester, Developer and staff), 'staff' (Admin and Moderator).
   post: the first message from POSTS, sent when the channel is created. */
export const CATEGORIES = [
  { name: '🛫 START HERE', channels: [
    { name: '👋┃welcome', access: 'readonly', post: 'welcome', topic: 'Welcome aboard! Start here ✈️' },
    { name: '📜┃rules', access: 'readonly', post: 'rules', topic: 'The flight rules. Read before you post 📋' },
    { name: '📢┃announcements', access: 'readonly', post: 'announcements', topic: 'Big news from the Stratos team 📣' },
    { name: '🚀┃releases', access: 'readonly', post: 'releases', topic: 'Every new version, hot off the runway 🔥' },
    { name: '🎭┃roles', access: 'readonly', post: 'roles', topic: 'Tell us how you fly 🛩️' },
  ] },
  { name: '☕ CREW LOUNGE', channels: [
    { name: '💬┃general', access: 'public', topic: 'Grab a coffee and chat ☕' },
    { name: '📸┃screenshots', access: 'public', topic: 'Sunsets, butter landings and that perfect shot 🌅' },
    { name: '🧾┃flight-logs', access: 'public', topic: 'Where did you fly today? Routes, landing rates and stories 🗺️' },
    { name: '🤝┃group-flights', access: 'public', topic: 'Find a wingman and fly together 👥' },
    { name: '🌍┃real-aviation', access: 'public', topic: 'Real-world aviation news and spotting 🔭' },
    { name: '🎲┃off-topic', access: 'public', topic: 'Anything goes (within the rules) 🎉' },
  ] },
  { name: '🧰 HANGAR (SUPPORT)', channels: [
    { name: '🆘┃help', type: 'forum', access: 'public', topic: 'One post per question. Tell us your sim, your OS and your Stratos version 🙏', tags: ['🛩️ X-Plane', '✈️ MSFS', '🔌 Bridge', '📱 Phone', '📒 EFB', '🗺️ Charts', '✅ Solved'] },
    { name: '🐞┃bug-reports', type: 'forum', access: 'public', topic: 'What happened, what you expected, how to repeat it, and a screenshot 🔍', tags: ['🗺️ Map', '📒 EFB', '📑 Charts', '📓 Logbook', '🔌 Bridge', '📱 Phone', '✅ Fixed'] },
    { name: '💡┃feature-requests', type: 'forum', access: 'public', topic: 'One idea per post. Vote with 👍', tags: ['🗺️ Map', '📒 EFB', '📑 Charts', '📱 Phone', '🗓️ Planned', '✅ Done'] },
    { name: '🔌┃bridge-setup', access: 'public', topic: 'Getting Stratos talking to your sim 🔧' },
  ] },
  { name: '🎮 SIMULATORS', channels: [
    { name: '🛩️┃x-plane', access: 'public', topic: 'X-Plane 12 pilots, this is your gate 🛩️' },
    { name: '✈️┃msfs', access: 'public', topic: 'MSFS 2020 & 2024 crew ✈️' },
    { name: '📒┃efb-and-charts', access: 'public', topic: 'The EFB, ChartFox charts and SimBrief 📑' },
    { name: '📡┃vatsim-ivao', access: 'public', topic: 'Flying online? Meet the crowd here 🎧' },
  ] },
  { name: '🧪 BETA TEST FLIGHT', channels: [
    { name: '🧪┃beta-chat', access: 'beta', topic: 'Fresh builds, still warm from the hangar 🔬' },
    { name: '📝┃beta-feedback', access: 'beta', topic: 'What flies, what crashes 💥' },
  ] },
  { name: '🎧 RADIO', channels: [
    { name: '🛫 Flight Deck', type: 'voice', access: 'public' },
    { name: '👥 Group Flight', type: 'voice', access: 'public' },
    { name: '🛠️ Support Call', type: 'voice', access: 'public' },
    { name: '☕ Crew Rest', type: 'voice', access: 'public' },
  ] },
  { name: '🔒 CREW ONLY', channels: [
    { name: '🗝️┃staff-chat', access: 'staff' },
    { name: '📋┃mod-log', access: 'staff' },
  ] },
];

/* First posts, sent once when their channel is created. */
export const POSTS = {
  welcome: `# ✈️ Welcome aboard Stratos!
Stratos is a live flight tracker and electronic flight bag for **X-Plane 12** 🛩️ and **MSFS 2020/2024** ✈️.
Track your flight on a live map, fly with charts and an EFB on your iPad, and log every landing 🧈

## 🚀 Get airborne in 3 steps
**1.** 📥 Download Stratos: https://www.stratos-tracker.com
**2.** 🖥️ Start it on the PC that runs your sim
**3.** 📱 Open the map or the EFB on your PC, phone or iPad

## 🧭 Where to go
🆘 Stuck? Ask in the help forum
🐞 Found a bug? Report it in bug-reports
💡 Got an idea? Share it in feature-requests
🎭 Grab your roles in roles

Blue skies and tailwinds! 🌤️`,
  rules: `# 📜 Flight Rules
**1.** 🤝 Be respectful. No harassment, hate speech or personal attacks.
**2.** 🎯 Stay on topic in each channel.
**3.** 🚫 No spam, ads or self-promotion without asking staff.
**4.** 🏴‍☠️ No pirated software or add-ons.
**5.** 🔍 Search help before posting a new question.
**6.** 🗣️ English in public channels.
**7.** 📘 Follow Discord's terms: https://discord.com/terms

⚖️ Staff decisions are final. Breaking the rules can mean a timeout or a ban.
Now go fly! ✈️`,
  announcements: `# 📢 Announcements
This is where the Stratos team posts the big news 📣
Turn on notifications for this channel so you never miss a release 🔔`,
  releases: `# 🚀 Releases
Every new version of Stratos lands here with what changed 🛬
Update the desktop app when it asks, and reload the app on your phone or iPad 🔄`,
  roles: `# 🎭 Pick your roles
Tell the crew how you fly!
🛩️ **X-Plane** · ✈️ **MSFS**: your simulator
📡 **VATSIM** · 📻 **IVAO**: your network

Ask a 🛡️ Moderator, or set these up as self-roles in **Server Settings → Onboarding** ✨`,
};
