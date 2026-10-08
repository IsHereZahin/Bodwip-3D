import { defineConfig, loadEnv, type Plugin } from 'vite';

/** The share card a link to the site shows (scripts/brand/share.mjs makes it), and its size. */
const SHARE = { path: 'brand/share.jpg', width: 1200, height: 630, alt: 'বদ্বীপ 3D: বাংলার গ্রামের শাপলা বিলে সূর্যাস্ত, ওপরে বদ্বীপের প্রতীক' };

/**
 * What only the site's own address can say, for search engines and shared links (`SITE_URL`, from the environment or
 * a .env file, e.g. https://example.org/bodwip/): the page's canonical link, its Open Graph and Twitter card address
 * and share image, and its structured data's address; and robots.txt with its sitemap. Unset, the page carries no
 * full address (a relative one would be wrong for them all) and robots.txt names no sitemap.
 */
function seo(siteUrl: string | undefined): Plugin {
  const url = siteUrl ? siteUrl.trim().replace(/\/*$/, '/') : null;
  const image = url ? url + SHARE.path : null;
  const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return {
    name: 'seo',
    transformIndexHtml(html) {
      const tags =
        url && image
          ? [
              `<link rel="canonical" href="${escape(url)}" />`,
              `<meta property="og:url" content="${escape(url)}" />`,
              `<meta property="og:image" content="${escape(image)}" />`,
              `<meta property="og:image:type" content="image/jpeg" />`,
              `<meta property="og:image:width" content="${SHARE.width}" />`,
              `<meta property="og:image:height" content="${SHARE.height}" />`,
              `<meta property="og:image:alt" content="${escape(SHARE.alt)}" />`,
              `<meta name="twitter:image" content="${escape(image)}" />`,
              `<meta name="twitter:image:alt" content="${escape(SHARE.alt)}" />`,
            ]
          : [];
      html = html.replace('<!-- seo:address -->', tags.join('\n    '));
      if (!url || !image) return html;
      // the structured data's own address: each node's id and url, the app's picture
      return html.replace(/(<script type="application\/ld\+json">)([\s\S]*?)(<\/script>)/, (_all, open: string, json: string, close: string) => {
        const data = JSON.parse(json) as { '@graph': Record<string, unknown>[] };
        for (const node of data['@graph']) {
          if (typeof node['@id'] === 'string') node['@id'] = url + node['@id'];
          node.url = url;
          if (node['@type'] === 'WebApplication') node.image = node.screenshot = image;
          const part = node.isPartOf as { '@id'?: string } | undefined;
          if (part?.['@id']) part['@id'] = url + part['@id'];
        }
        return `${open}\n      ${JSON.stringify(data, null, 2).replace(/\n/g, '\n      ')}\n    ${close}`;
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'robots.txt', source: `User-agent: *\nAllow: /\n${url ? `\nSitemap: ${url}sitemap.xml\n` : ''}` });
      if (!url) return;
      const day = new Date().toISOString().slice(0, 10);
      this.emitFile({
        type: 'asset',
        fileName: 'sitemap.xml',
        source: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url>\n    <loc>${escape(url)}</loc>\n    <lastmod>${day}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>1.0</priority>\n  </url>\n</urlset>\n`,
      });
    },
  };
}

export default defineConfig(({ mode }) => ({
  base: './',
  plugins: [seo(loadEnv(mode, '.', '').SITE_URL)],
  build: {
    target: 'es2022',
    outDir: 'dist',
    assetsDir: 'bundle',
  },
}));
