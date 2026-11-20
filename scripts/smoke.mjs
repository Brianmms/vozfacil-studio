const base = process.env.SMOKE_URL || 'https://vozfacil-studio.pages.dev';

async function main() {
  const res = await fetch(base, { redirect: 'follow' });
  if (res.status !== 200) throw new Error(`root status ${res.status}`);

  if (!res.headers.get('content-security-policy')) throw new Error('missing CSP header');
  if (!res.headers.get('x-frame-options')) throw new Error('missing X-Frame-Options header');

  const html = await res.text();
  const asset = html.match(/assets\/index-[A-Za-z0-9_-]+\.js/)?.[0];
  if (!asset) throw new Error('no JS asset referenced in index.html');

  const jsRes = await fetch(new URL(asset, base));
  if (jsRes.status !== 200) throw new Error(`js status ${jsRes.status}`);
  const contentType = jsRes.headers.get('content-type') || '';
  if (!contentType.includes('javascript')) {
    throw new Error(`unexpected JS content-type: ${contentType}`);
  }

  console.log(`OK ${base} -> ${asset} (${jsRes.status})`);
}

main().catch((error) => {
  console.error('SMOKE FAILED:', error instanceof Error ? error.message : error);
  process.exit(1);
});
