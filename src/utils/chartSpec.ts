/**
 * Normalizes Vega-Lite chart specs returned by the chat/analytics backend so
 * they are readable regardless of which code path produced them.
 *
 * Fixes two recurring problems:
 *  1. Large, close values (e.g. 187892 vs 187200) look identical because the
 *     quantitative axis starts at zero — the difference is a rounding error of
 *     the full bar height. We disable the zero baseline so differences become
 *     visible. When we can read the data we compute a tight padded domain; when
 *     we can't (data lives in a named dataset, or the field key differs) we
 *     still set `scale.zero = false` and let Vega auto-fit the domain.
 *  2. Poor labeling — missing axis titles, unreadable large numbers, and no
 *     tooltips. We add titles, SI-formatted ticks (187.9k), full-number
 *     tooltips, and label overlap handling.
 *
 * It is defensive: any error returns the original spec unchanged.
 */

const prettify = (field: string): string =>
  String(field)
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * Collect the data rows from a spec. Vega-Lite data can be inline
 * (`data.values`) or referenced by name (`data.name` -> `datasets[name]`).
 * We also fall back to the first array we find under `datasets`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const collectValues = (spec: any): any[] => {
  if (Array.isArray(spec?.data?.values)) return spec.data.values;
  const datasets = spec?.datasets;
  if (datasets && typeof datasets === 'object') {
    const named = spec?.data?.name;
    if (named && Array.isArray(datasets[named])) return datasets[named];
    for (const key of Object.keys(datasets)) {
      if (Array.isArray(datasets[key])) return datasets[key];
    }
  }
  return [];
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const enhanceAxis = (enc: any, values: any[]): void => {
  if (!enc || enc.type !== 'quantitative' || !enc.field) return;

  if (!enc.title) enc.title = prettify(enc.field);

  const nums = values
    .map((r) => Number(r?.[enc.field]))
    .filter((v) => typeof v === 'number' && !isNaN(v));

  if (nums.length >= 2) {
    const min = Math.min(...nums);
    const max = Math.max(...nums);
    const range = max - min;
    const magnitude = Math.max(Math.abs(min), Math.abs(max));

    // Narrow range relative to magnitude -> tight padded domain so the visible
    // bar/line/point lengths reflect the actual differences.
    if (magnitude > 0 && range > 0 && range / magnitude < 0.4) {
      const pad = range * 0.15 || magnitude * 0.02;
      enc.scale = { ...(enc.scale || {}), zero: false, nice: true, domain: [min - pad, max + pad] };
    } else if (magnitude >= 1000) {
      // Wider range but still large numbers — drop zero so differences show.
      enc.scale = { ...(enc.scale || {}), zero: false, nice: true };
    }
    if (magnitude >= 1000) {
      enc.axis = { ...(enc.axis || {}), format: '~s' };
    }
  } else {
    // We couldn't read the data (named dataset / field mismatch). Default to a
    // non-zero baseline so close values are still distinguishable; Vega will
    // auto-compute the domain from the actual data.
    enc.scale = { ...(enc.scale || {}), zero: false, nice: true };
    enc.axis = { ...(enc.axis || {}), format: '~s' };
  }
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const enhanceEncoding = (encoding: any, values: any[]): void => {
  if (!encoding) return;
  enhanceAxis(encoding.x, values);
  enhanceAxis(encoding.y, values);

  // Improve categorical x-axis label readability.
  if (encoding.x && (encoding.x.type === 'nominal' || encoding.x.type === 'ordinal')) {
    encoding.x.axis = { labelAngle: -35, labelOverlap: true, ...(encoding.x.axis || {}) };
  }

  // Add full-number tooltips if none are defined.
  if (!encoding.tooltip) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tips: any[] = [];
    for (const key of ['x', 'y', 'color']) {
      const e = encoding[key];
      if (e && e.field) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tip: any = { field: e.field, type: e.type, title: e.title || prettify(e.field) };
        if (e.type === 'quantitative') tip.format = ',.0f';
        tips.push(tip);
      }
    }
    if (tips.length > 0) encoding.tooltip = tips;
  }
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function normalizeChartSpec(spec: any): any {
  if (!spec || typeof spec !== 'object') return spec;
  try {
    const clone = JSON.parse(JSON.stringify(spec));
    const values = collectValues(clone);

    if (clone.encoding) enhanceEncoding(clone.encoding, values);
    if (Array.isArray(clone.layer)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      clone.layer.forEach((l: any) => enhanceEncoding(l.encoding, values));
    }

    // Make charts responsive to their container when no explicit width is set.
    if (clone.width == null && !clone.layer) clone.width = 'container';

    return clone;
  } catch {
    return spec;
  }
}
