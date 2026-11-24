#!/usr/bin/env node
/* Discord's own features, set up through the API (nothing to host):
     - join messages in the arrivals channel
     - the Channels & Roles picker (simulator and network roles) in Onboarding
     - a "Stratos Releases" webhook in the releases channel
   $env:DISCORD_TOKEN = '<bot token>'; node community/discord/extras.mjs <server id>
   The webhook URL is written to the file given by --webhook-out, never printed. */
import fs from 'node:fs';

const guild = process.argv.slice(2).find(arg => /^\d{15,22}$/.test(arg));
const outAt = process.argv.indexOf('--webhook-out');
const webhookOut = outAt > 0 ? process.argv[outAt + 1] : '';
const token = process.env.DISCORD_TOKEN;
if (!guild || !token) throw new Error('Usage: set DISCORD_TOKEN, then: node community/discord/extras.mjs <server id> [--webhook-out file]');

async function api(method, path, body) {
  for (;;) {
    const res = await fetch(`https://discord.com/api/v10${path}`, {
      method, headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429) { const wait = ((await res.json()).retry_after || 1) * 1000; await new Promise(r => setTimeout(r, wait)); continue; }
    const data = res.status === 204 ? null : await res.json();
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(data)}`);
    return data;
  }
}

const channels = await api('GET', `/guilds/${guild}/channels`);
const roles = await api('GET', `/guilds/${guild}/roles`);
const channel = part => channels.find(c => c.name.includes(part));
const role = name => roles.find(r => r.name === name);
const need = (value, what) => { if (!value) throw new Error(`${what} not found on the server`); return value; };

// 1. Join messages ("Welcome, X!" with a wave button) go to arrivals.
const arrivals = need(channel('arrivals'), 'the arrivals channel');
await api('PATCH', `/guilds/${guild}`, { system_channel_id: arrivals.id, system_channel_flags: 0 });
console.log(`join messages  → #${arrivals.name}`);

// 2. Channels & Roles: new members pick their sim and network.
let next = BigInt(Date.now() - 1420070400000) << 22n; // Discord-style ids for new prompts and options
const id = () => String(next++);
const option = (roleName, title, emoji, description) => ({
  id: id(), title, description, emoji: { name: emoji }, role_ids: [need(role(roleName), roleName).id], channel_ids: [],
});
const prompts = [
  { id: id(), type: 0, title: 'Which simulator do you fly? 🛫', single_select: false, required: false, in_onboarding: true, options: [
    option('🛩️ X-Plane', 'X-Plane 12', '🛩️', 'Laminar Research X-Plane'),
    option('✈️ MSFS', 'MSFS 2020 / 2024', '✈️', 'Microsoft Flight Simulator'),
  ] },
  { id: id(), type: 0, title: 'Do you fly online? 🎧', single_select: false, required: false, in_onboarding: true, options: [
    option('📡 VATSIM', 'VATSIM', '📡', 'Flying on the VATSIM network'),
    option('📻 IVAO', 'IVAO', '📻', 'Flying on the IVAO network'),
  ] },
];
// Onboarding needs default channels everyone can see; the public ones are.
const defaults = ['welcome', 'rules', 'announcements', 'releases', 'general', 'screenshots', 'flight-logs', 'help', 'group-flights', 'off-topic']
  .map(channel).filter(Boolean).map(c => c.id);
await api('PUT', `/guilds/${guild}/onboarding`, { prompts, default_channel_ids: defaults, enabled: true, mode: 0 });
console.log(`role picker    → ${prompts.length} questions in Onboarding`);

// 3. The releases webhook.
const releases = need(channel('releases'), 'the releases channel');
const hooks = await api('GET', `/channels/${releases.id}/webhooks`);
const hook = hooks.find(h => h.name === 'Stratos Releases')
  || await api('POST', `/channels/${releases.id}/webhooks`, { name: 'Stratos Releases' });
const url = `https://discord.com/api/webhooks/${hook.id}/${hook.token}`;
if (webhookOut) fs.writeFileSync(webhookOut, url + '\n');
console.log(`releases hook  → #${releases.name}${webhookOut ? ' (URL saved to the file)' : ''}`);
