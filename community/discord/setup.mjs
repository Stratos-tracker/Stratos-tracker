#!/usr/bin/env node
/* Build the Stratos Discord server from server.mjs.

     $env:DISCORD_TOKEN = '<bot token>'; node community/discord/setup.mjs <server id>
     node community/discord/setup.mjs --dry-run

   Safe to run again: roles and channels that already exist (same name) are
   kept, and a first post is only sent into an empty channel. The token is read
   from the environment and sent only to discord.com. */
import { BETA, CATEGORIES, POSTS, ROLES, STAFF } from './server.mjs';

const BIT = {
  ADMINISTRATOR: 1n << 3n, KICK_MEMBERS: 1n << 1n, BAN_MEMBERS: 1n << 2n, VIEW_AUDIT_LOG: 1n << 7n,
  VIEW_CHANNEL: 1n << 10n, SEND_MESSAGES: 1n << 11n, MANAGE_MESSAGES: 1n << 13n, CONNECT: 1n << 20n,
  MANAGE_NICKNAMES: 1n << 27n, MANAGE_THREADS: 1n << 34n, CREATE_PUBLIC_THREADS: 1n << 35n,
  SEND_MESSAGES_IN_THREADS: 1n << 38n, MODERATE_MEMBERS: 1n << 40n,
};
const bits = names => names.reduce((sum, name) => sum | BIT[name], 0n).toString();
const TYPE = { text: 0, voice: 2, category: 4, forum: 15 };
const TALK = ['SEND_MESSAGES', 'SEND_MESSAGES_IN_THREADS', 'CREATE_PUBLIC_THREADS'];

/** Permission overwrites for one access level. `ids` maps role names (and @everyone) to ids. */
export function overwrites(access, ids) {
  const role = (name, allow, deny = []) => ({ id: ids[name], type: 0, allow: bits(allow), deny: bits(deny) });
  const staff = STAFF.map(name => role(name, ['VIEW_CHANNEL', ...TALK]));
  if (access === 'readonly') return [role('@everyone', ['VIEW_CHANNEL'], TALK), ...staff];
  if (access === 'beta') return [role('@everyone', [], ['VIEW_CHANNEL', 'CONNECT']), ...BETA.map(name => role(name, ['VIEW_CHANNEL', ...TALK])), ...staff];
  if (access === 'staff') return [role('@everyone', [], ['VIEW_CHANNEL', 'CONNECT']), ...staff];
  return [];
}

async function main() {
  const dry = process.argv.includes('--dry-run');
  const guild = process.argv.slice(2).find(arg => /^\d{15,22}$/.test(arg));
  const token = process.env.DISCORD_TOKEN;
  if (dry) {
    for (const r of ROLES) console.log(`role      ${r.name}`);
    for (const c of CATEGORIES) {
      console.log(`category  ${c.name}`);
      for (const ch of c.channels) console.log(`  ${(ch.type || 'text').padEnd(6)}  ${ch.name}  [${ch.access}]${POSTS[ch.post] ? '  + first post' : ''}`);
    }
    return;
  }
  if (!guild || !token) throw new Error('Usage: set DISCORD_TOKEN, then: node community/discord/setup.mjs <server id>');

  const api = async (method, path, body) => {
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
  };

  const roles = await api('GET', `/guilds/${guild}/roles`);
  const ids = { '@everyone': guild };
  for (const r of roles) ids[r.name] = r.id;
  for (const r of ROLES) {
    if (ids[r.name]) { console.log(`kept      role ${r.name}`); continue; }
    ids[r.name] = (await api('POST', `/guilds/${guild}/roles`, { name: r.name, color: r.color, hoist: r.hoist, permissions: bits(r.perms) })).id;
    console.log(`created   role ${r.name}`);
  }

  const existing = await api('GET', `/guilds/${guild}/channels`);
  const find = (name, type, parent) => existing.find(c => c.name === name && c.type === type && (parent === undefined || c.parent_id === parent));
  for (const cat of CATEGORIES) {
    let category = find(cat.name, TYPE.category);
    if (!category) { category = await api('POST', `/guilds/${guild}/channels`, { name: cat.name, type: TYPE.category }); existing.push(category); }
    for (const ch of cat.channels) {
      const type = TYPE[ch.type || 'text'];
      const name = type === TYPE.voice ? ch.name : ch.name.toLowerCase();
      if (find(name, type, category.id)) { console.log(`kept      #${name}`); continue; }
      const body = { name, type, parent_id: category.id, permission_overwrites: overwrites(ch.access, ids) };
      if (ch.topic) body.topic = ch.topic;
      if (ch.tags) body.available_tags = ch.tags.map(tag => ({ name: tag }));
      let made;
      try { made = await api('POST', `/guilds/${guild}/channels`, body); }
      catch (error) {
        // Forum channels need Community enabled; fall back to a text channel.
        if (type !== TYPE.forum) throw error;
        delete body.available_tags; body.type = TYPE.text;
        made = await api('POST', `/guilds/${guild}/channels`, body);
        console.log(`note      #${name} is a text channel: enable Community to make it a forum`);
      }
      existing.push(made);
      console.log(`created   #${name}`);
      if (POSTS[ch.post]) await api('POST', `/channels/${made.id}/messages`, { content: POSTS[ch.post] });
    }
  }
  console.log('Done. Move the bot role above the roles it created, or remove the bot.');
}

if (process.argv[1]?.endsWith('setup.mjs')) {
  main().catch(error => { console.error(error.message); process.exit(1); });
}
