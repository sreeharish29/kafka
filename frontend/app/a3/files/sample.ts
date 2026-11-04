/* A built-in run so the page works before you load your own files.
   Same event shapes as search_fetch.py emits. */

import type { Article, Ev } from './model';

const URLS = [
  'https://www.theatlantic.com/international/2026/10/india-modi-cockroach-janta-party/689183',
  'https://www.aljazeera.com/news/2026/11/3/how-india-pulled-500-million-people-out-of-poverty-as-inequality-deepens',
  'https://www.ndtv.com/india',
  'https://www.cnbc.com/2026/10/29/india-china-us-israel-military-spending.html',
  'https://www.reuters.com/world/india/indias-2026-gold-demand-seen-falling-six-year-low-price-rise-2026-11-03',
  'https://www.aljazeera.com/features/2026/10/28/why-india-has-soured-on-trump-ahead-of-us-midterms',
  'https://science.nasa.gov/earth/earth-observatory/arnab-strikes-india',
  'https://www.newyorker.com/news/the-lede/inside-indias-cockroach-protests',
  'https://www.reuters.com/business/retail-consumer/nike-deepens-india-push-with-new-running-shoe-seeking-fresh-growth-engines-2026-10-29',
  'https://www.reuters.com/business/energy/coal-india-misses-profit-view-costs-rise-amid-strong-demand-2026-10-29',
  'https://www.reuters.com/world/india/india-markets-regulator-backs-removal-long-term-capital-gains-tax-foreign-2026-11-02',
  'https://www.reuters.com/world/india/indias-auto-stocks-rise-strong-october-sales-signal-resilient-festive-demand-2026-11-02',
  'https://www.bbc.com/news/world-asia-india-67890123',
  'https://www.thehindu.com/news/national/monsoon-withdrawal-delayed/article70000001.ece',
  'https://economictimes.indiatimes.com/markets/stocks/news/sensex-nifty-close-higher',
  'https://www.theguardian.com/world/india',
];

const DURS = [0.85, 1.72, 1.35, 2.4, 0.9, 3.1, 1.1, 2.7, 0.8, 1.9, 1.45, 2.2];

export function makeSample(): { events: Ev[]; articles: Record<string, Article> } {
  const ev: Ev[] = [];
  const articles: Record<string, Article> = {};

  ev.push({ t: 0, type: 'run_start', queries: ['India'], workers: 6 });
  ev.push({ t: 3.34, type: 'search_start', job: 'newsdata:0', source: 'newsdata', query: 'India' });
  ev.push({ t: 3.341, type: 'search_start', job: 'mcp:0', source: 'mcp', query: 'India' });
  ev.push({ t: 4.415, type: 'search_error', job: 'newsdata:0', source: 'newsdata', query: 'India', error: "RuntimeError('newsdata HTTP 422')" });

  URLS.forEach((url, i) => ev.push({ t: 16.066 + i * 0.0004, type: 'url_queued', job: 'mcp:0', url }));
  ev.push({ t: 16.068, type: 'search_done', job: 'mcp:0', source: 'mcp', query: 'India', n_urls: URLS.length, n_new: URLS.length });

  const free = Array<number>(6).fill(16.07);
  let ok = 0;
  URLS.forEach((url, n) => {
    const w = free.indexOf(Math.min(...free));
    const start = free[w] + (n < 6 ? w * 0.0025 : 0);
    const dur = DURS[n % DURS.length];
    const fail = url.includes('reuters.com');
    const end = start + dur;
    ev.push({ t: +start.toFixed(3), type: 'crawl_start', worker: w, url });
    ev.push({
      t: +end.toFixed(3), type: 'crawl_done', worker: w, url, ok: !fail,
      chars: fail ? 0 : 4000 + ((n * 2371) % 15000),
      error: fail ? 'Blocked by anti-bot protection: DataDome captcha' : null,
    });
    articles[url] = {
      url, final_url: url, success: !fail,
      error: fail ? 'Blocked by anti-bot protection: DataDome captcha' : null,
      title: fail ? 'reuters.com' : `Sample article ${n + 1}`,
      text: fail ? '' : 'Sample text. Load your own articles.json to see the real page text here.',
      found_by: ['mcp'],
    };
    if (!fail) ok++;
    free[w] = end + 0.001;
  });

  ev.sort((a, b) => a.t - b.t);
  ev.push({ t: ev[ev.length - 1].t + 0.01, type: 'finished', total: URLS.length, ok });
  return { events: ev, articles };
}
