// Fetches the upstream M3U playlist server-side (avoids browser CORS issues),
// parses it into clean JSON and lets Netlify's CDN cache the result.
const SOURCE = 'https://raw.githubusercontent.com/abusaeeidx/Mrgify-BDIX-IPTV/main/playlist.m3u'

type Channel = { id: string; name: string; group: string; logo: string; url: string }

const GROUP_ALIASES: Record<string, string> = {
  bangla: 'Bangla',
  'welcome to playz tv | new app': 'Promo',
  urdhu: 'Urdu',
  '[live] bdix ♛': 'BDIX Live',
}

function hash(input: string) {
  let h = 2166136261
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36)
}

function attr(line: string, key: string) {
  const m = line.match(new RegExp(`${key}="([^"]*)"`, 'i'))
  return m ? m[1].trim() : ''
}

function parse(text: string): Channel[] {
  const out: Channel[] = []
  const seen = new Set<string>()
  let info: { name: string; group: string; logo: string } | null = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('#EXTINF')) {
      // The display name is whatever follows the last attribute's closing quote + comma
      const afterAttrs = line.replace(/^#EXTINF:[^,]*?((\s[\w-]+="[^"]*")*)\s*,/, '')
      const group = attr(line, 'group-title') || 'Others'
      info = {
        name: afterAttrs.trim() || attr(line, 'tvg-name'),
        group: GROUP_ALIASES[group.toLowerCase()] || group,
        logo: attr(line, 'tvg-logo'),
      }
    } else if (!line.startsWith('#')) {
      const url = line.replace(/^hls:\/\//i, 'http://')
      if (!/^https?:\/\//i.test(url)) { info = null; continue }
      const name = info?.name || 'Untitled channel'
      const id = hash(name + '|' + url)
      if (!seen.has(id)) {
        seen.add(id)
        out.push({ id, name, group: info?.group || 'Others', logo: info?.logo || '', url })
      }
      info = null
    }
  }
  return out
}

export default async () => {
  try {
    const res = await fetch(SOURCE, { headers: { 'user-agent': 'PlayWithTV/1.0' } })
    if (!res.ok) throw new Error(`Upstream responded ${res.status}`)
    const text = await res.text()
    const channels = parse(text)
    const updated = (text.match(/Last Updated:\s*(.+)/i) || [])[1]?.trim() || null
    return Response.json(
      { updated, count: channels.length, channels },
      {
        headers: {
          'Cache-Control': 'public, max-age=300',
          'Netlify-CDN-Cache-Control': 'public, durable, s-maxage=1800, stale-while-revalidate=86400',
        },
      },
    )
  } catch (err) {
    return Response.json({ error: 'Could not load the channel list right now.' }, { status: 502 })
  }
}

export const config = { path: '/api/playlist' }
