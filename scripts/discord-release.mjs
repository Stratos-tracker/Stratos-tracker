#!/usr/bin/env node
/* Post a published release to the Discord releases channel through its webhook.
     DISCORD_RELEASES_WEBHOOK=<url> node scripts/discord-release.mjs [manifest] [version]
   Reads the notes from the release manifest (app/releases.json by default), so
   the post says exactly what the update centre says. */
import fs from 'node:fs';

const LABELS = { features: '✨ New', improvements: '⚡ Better', fixes: '🛠️ Fixed', performance: '🚀 Faster', ui: '🎨 Looks', compatibility: '⚠️ Important' };

/** The Discord message for one manifest release entry. */
export function releaseMessage(release, pingRole = '') {
  const changelog = release.changelog || {};
  const fields = Object.entries(LABELS)
    .filter(([key]) => Array.isArray(changelog[key]) && changelog[key].length)
    .map(([key, name]) => ({ name, value: changelog[key].map(item => `• ${item}`).join('\n').slice(0, 1024) }));
  return {
    username: 'Stratos Releases',
    content: `${/^\d+$/.test(pingRole) ? `<@&${pingRole}> ` : ''}🚀 **Stratos ${release.version} has landed!**`,
    allowed_mentions: { roles: /^\d+$/.test(pingRole) ? [pingRole] : [] },
    embeds: [{
      title: `Stratos ${release.version}`,
      url: `https://github.com/Stratos-tracker/Stratos-tracker/releases/tag/v${release.version}`,
      description: `${release.summary || ''}\n\n📥 [Download](https://www.stratos-tracker.com) · 🔄 Phone and iPad: reopen the app`.slice(0, 4000),
      color: 0x8b5cf6,
      fields,
      footer: { text: 'Blue skies ✈️' },
      timestamp: release.releasedAt ? new Date(release.releasedAt).toISOString() : undefined,
    }],
  };
}

async function main() {
  const url = process.env.DISCORD_RELEASES_WEBHOOK;
  if (!url) { console.log('No DISCORD_RELEASES_WEBHOOK: nothing posted.'); return; }
  if (!/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//.test(url)) throw new Error('DISCORD_RELEASES_WEBHOOK is not a Discord webhook URL');
  const manifest = JSON.parse(fs.readFileSync(process.argv[2] || 'app/releases.json', 'utf8'));
  const want = process.argv[3];
  const release = !want || manifest.latest.version === want ? manifest.latest : (manifest.releases || []).find(r => r.version === want);
  if (!release) throw new Error(`No release ${want} in the manifest`);
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(releaseMessage(release, process.env.DISCORD_PING_ROLE)) });
  if (!res.ok) throw new Error(`Discord answered ${res.status}: ${await res.text()}`);
  console.log(`Posted Stratos ${release.version} to Discord.`);
}

if (process.argv[1]?.endsWith('discord-release.mjs')) main().catch(error => { console.error(error.message); process.exit(1); });
