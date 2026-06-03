import React, { useMemo, useState } from 'react';
import { Box, Typography, IconButton, Collapse, Tooltip, Chip } from '@mui/material';
import { ExpandMore, ExpandLess, ContentCopy, AutoAwesome, OpenInNew } from '@mui/icons-material';
import { Highlight, themes } from 'prism-react-renderer';

/**
 * @file DataProductInsights.tsx
 * @summary Renders the data product's "Insights" tab — the LLM-generated
 * "Query recommendations" Google surfaces in the Dataplex console.
 *
 * Those recommendations live in the data product's Dataplex `queries` aspect
 * (already fetched with the product). The aspect value can arrive either as a
 * protobuf Struct (`{ fields: { ... stringValue/listValue/structValue } }`) or
 * as plain JSON, so we unwrap defensively and scan for objects that carry a
 * SQL-like field paired with a natural-language description.
 */

interface DataProductInsightsProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  entry: any;
}

interface RecommendedQuery {
  description: string;
  query: string;
}

// Unwrap a single protobuf Value (or plain value) into plain JS.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const unwrap = (v: any): any => {
  if (v === null || v === undefined) return v;
  if (typeof v !== 'object') return v;
  if ('stringValue' in v) return v.stringValue;
  if ('numberValue' in v) return v.numberValue;
  if ('boolValue' in v) return v.boolValue;
  if ('nullValue' in v) return null;
  if ('listValue' in v) return (v.listValue?.values || []).map(unwrap);
  if ('structValue' in v) return unwrapFields(v.structValue?.fields);
  if (v.kind === 'stringValue') return v.stringValue;
  if (v.kind === 'numberValue') return v.numberValue;
  if (v.kind === 'boolValue') return v.boolValue;
  if (v.kind === 'listValue') return (v.listValue?.values || []).map(unwrap);
  if (v.kind === 'structValue') return unwrapFields(v.structValue?.fields);
  if (Array.isArray(v)) return v.map(unwrap);
  return unwrapFields(v);
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const unwrapFields = (fields: any): any => {
  if (!fields || typeof fields !== 'object') return fields;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: Record<string, any> = {};
  for (const k of Object.keys(fields)) out[k] = unwrap(fields[k]);
  return out;
};

// Pick the first string value whose key matches one of `keys` (case-insensitive).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pickString = (obj: any, keys: string[]): string | null => {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of Object.keys(obj)) {
    if (keys.includes(k.toLowerCase())) {
      const val = obj[k];
      if (typeof val === 'string' && val.trim()) return val;
    }
  }
  return null;
};

const SQL_KEYS = ['query', 'sql', 'statement', 'querytext', 'query_text', 'sqlquery'];
const DESC_KEYS = ['description', 'prompt', 'question', 'name', 'title', 'nl', 'natural_language', 'naturallanguage', 'label'];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const extractQueries = (entry: any): RecommendedQuery[] => {
  const aspects = entry?.aspects || {};
  const result: RecommendedQuery[] = [];
  const seen = new Set<string>();

  for (const key of Object.keys(aspects)) {
    const aspectType: string = aspects[key]?.aspectType || '';
    const isQueriesAspect =
      /queries$/i.test(aspectType) ||
      /\.queries$/i.test(key) ||
      key.toLowerCase().includes('queries') ||
      key.toLowerCase().includes('insight');
    if (!isQueriesAspect) continue;

    const raw = aspects[key]?.data;
    const data = raw?.fields ? unwrapFields(raw.fields) : unwrap(raw);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scan = (node: any) => {
      if (!node) return;
      if (Array.isArray(node)) { node.forEach(scan); return; }
      if (typeof node === 'object') {
        const sql = pickString(node, SQL_KEYS);
        if (sql) {
          const description = pickString(node, DESC_KEYS) || 'Recommended query';
          const dedupeKey = sql.replace(/\s+/g, ' ').trim();
          if (!seen.has(dedupeKey)) {
            seen.add(dedupeKey);
            result.push({ description, query: sql });
          }
          return;
        }
        Object.values(node).forEach(scan);
      }
    };
    scan(data);
  }
  return result;
};

const DataProductInsights: React.FC<DataProductInsightsProps> = ({ entry }) => {
  const queries = useMemo(() => extractQueries(entry), [entry]);
  const [expanded, setExpanded] = useState<number | null>(0);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  const handleCopy = async (query: string, index: number) => {
    try {
      await navigator.clipboard.writeText(query);
      setCopiedIndex(index);
      setTimeout(() => setCopiedIndex(null), 2000);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Failed to copy query:', err);
    }
  };

  // BigQuery Studio deep-link: the SQL (with the description as a leading
  // comment) is URL-encoded into the `create-new-query-tab` matrix parameter,
  // which opens a new query tab pre-filled with the query — same behaviour as
  // the Dataplex console's "Open in BigQuery".
  const openInBigQuery = (item: RecommendedQuery) => {
    const text = `-- ${item.description}\n${item.query}`;
    const url = `https://console.cloud.google.com/bigquery;create-new-query-tab=${encodeURIComponent(text)}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  return (
    <Box sx={{ padding: '8px 0 24px' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: '8px', mb: 0.5 }}>
        <Typography sx={{ fontFamily: '"Google Sans", sans-serif', fontWeight: 500, fontSize: '20px', color: '#1F1F1F' }}>
          Insights
        </Typography>
        <Chip label="Preview" size="small" sx={{ height: '20px', fontSize: '11px', backgroundColor: '#E8EAED', color: '#3C4043' }} />
      </Box>
      <Typography sx={{ fontFamily: '"Google Sans", sans-serif', fontSize: '14px', color: '#575757', mb: 2 }}>
        Recommended queries for data product consumers.
      </Typography>

      {queries.length === 0 ? (
        <Box sx={{ padding: '40px', textAlign: 'center', border: '1px solid #DADCE0', borderRadius: '12px' }}>
          <Typography sx={{ fontFamily: '"Google Sans", sans-serif', fontSize: '14px', color: '#575757' }}>
            No query recommendations available for this data product.
          </Typography>
        </Box>
      ) : (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {queries.map((item, index) => (
            <Box key={index} sx={{ border: '1px solid #DADCE0', borderRadius: '12px', overflow: 'hidden' }}>
              <Box
                onClick={() => setExpanded(expanded === index ? null : index)}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '12px',
                  padding: '16px 20px',
                  cursor: 'pointer',
                  backgroundColor: expanded === index ? '#F8FAFD' : 'transparent',
                  '&:hover': { backgroundColor: '#F8FAFD' },
                }}
              >
                <Box sx={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1, minWidth: 0 }}>
                  <Typography sx={{ fontFamily: '"Google Sans", sans-serif', fontSize: '14px', color: '#1F1F1F', flex: 1 }}>
                    {item.description}
                  </Typography>
                  <Chip
                    icon={<AutoAwesome sx={{ fontSize: '14px !important' }} />}
                    label="LLM"
                    size="small"
                    sx={{ height: '22px', fontSize: '11px', backgroundColor: '#E8EAED', color: '#3C4043', flexShrink: 0 }}
                  />
                </Box>
                <Box sx={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
                  <Tooltip title={copiedIndex === index ? 'Copied!' : 'Copy query'}>
                    <IconButton
                      size="small"
                      onClick={(e) => { e.stopPropagation(); handleCopy(item.query, index); }}
                      sx={{ color: copiedIndex === index ? '#34A853' : '#5F6368' }}
                    >
                      <ContentCopy sx={{ fontSize: '16px' }} />
                    </IconButton>
                  </Tooltip>
                  {expanded === index ? <ExpandLess sx={{ color: '#5F6368' }} /> : <ExpandMore sx={{ color: '#5F6368' }} />}
                </Box>
              </Box>
              <Collapse in={expanded === index}>
                <Box sx={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', px: 2.5, py: 1, borderTop: '1px solid #E9EEF6' }}>
                  <Box
                    component="button"
                    onClick={(e) => { e.stopPropagation(); openInBigQuery(item); }}
                    sx={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '6px',
                      background: 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                      color: '#0B57D0',
                      fontFamily: '"Google Sans", sans-serif',
                      fontSize: '13px',
                      fontWeight: 500,
                      padding: '4px 8px',
                      borderRadius: '4px',
                      '&:hover': { backgroundColor: 'rgba(11,87,208,0.08)' },
                    }}
                  >
                    <OpenInNew sx={{ fontSize: '16px' }} />
                    Open in BigQuery
                  </Box>
                </Box>
                <Highlight theme={themes.nightOwlLight} code={item.query || ''} language="sql">
                  {({ className, style, tokens, getLineProps, getTokenProps }) => (
                    <Box
                      component="pre"
                      className={className}
                      sx={{
                        ...style,
                        px: 2.5,
                        py: 2,
                        margin: 0,
                        fontSize: '13px',
                        lineHeight: 1.6,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                        overflowX: 'auto',
                      }}
                    >
                      {tokens.map((line, i) => (
                        <div key={i} {...getLineProps({ line })}>
                          {line.map((token, k) => (
                            <span key={k} {...getTokenProps({ token })} />
                          ))}
                        </div>
                      ))}
                    </Box>
                  )}
                </Highlight>
              </Collapse>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
};

export default DataProductInsights;
