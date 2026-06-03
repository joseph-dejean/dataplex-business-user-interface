import React, { useMemo, useState } from 'react';
import { Box, Typography, IconButton, Collapse, Tooltip, Chip, Snackbar } from '@mui/material';
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

const DESC_KEYS = ['description', 'prompt', 'question', 'name', 'title', 'nl', 'natural_language', 'naturallanguage', 'label'];

// A string is the SQL (not the natural-language prompt) when it reads like a
// query. We detect by CONTENT, not field name, because the aspect stores the
// description and the SQL under unpredictable keys.
const looksLikeSql = (s: unknown): boolean =>
  typeof s === 'string' && /\bSELECT\b[\s\S]*\bFROM\b/i.test(s);

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
      if (typeof node !== 'object') return;
      // Collect this node's string fields, then identify the SQL by content.
      const strings = Object.entries(node)
        .filter(([, v]) => typeof v === 'string' && (v as string).trim()) as [string, string][];
      const sqlEntry = strings.find(([, v]) => looksLikeSql(v));
      if (sqlEntry) {
        const sql = sqlEntry[1];
        // Description: prefer a known description field; else the first other
        // non-SQL string; else a default.
        let description = '';
        for (const [k, v] of strings) {
          if (v !== sql && DESC_KEYS.includes(k.toLowerCase())) { description = v; break; }
        }
        if (!description) {
          const other = strings.find(([, v]) => v !== sql && !looksLikeSql(v));
          description = other ? other[1] : 'Recommended query';
        }
        const dedupeKey = sql.replace(/\s+/g, ' ').trim();
        if (!seen.has(dedupeKey)) {
          seen.add(dedupeKey);
          result.push({ description, query: sql });
        }
        return;
      }
      Object.values(node).forEach(scan);
    };
    scan(data);
  }
  return result;
};

const DataProductInsights: React.FC<DataProductInsightsProps> = ({ entry }) => {
  const queries = useMemo(() => extractQueries(entry), [entry]);
  const [expanded, setExpanded] = useState<number | null>(0);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [bqCopied, setBqCopied] = useState(false);

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

  // Open BigQuery Studio for the query. We try the `create-new-query-tab`
  // deep-link (auto-fills the editor when the console honours it), but that
  // isn't reliable across console hosts — so we ALSO copy the SQL to the
  // clipboard and tell the user to paste, which always works.
  const openInBigQuery = async (item: RecommendedQuery) => {
    const text = `-- ${item.description}\n${item.query}`;
    try {
      await navigator.clipboard.writeText(item.query);
      setBqCopied(true);
      setTimeout(() => setBqCopied(false), 4000);
    } catch {
      // clipboard may be blocked; the deep-link below is the fallback
    }
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
      <Snackbar
        open={bqCopied}
        autoHideDuration={4000}
        onClose={() => setBqCopied(false)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        message="Query copied — paste it in BigQuery (Ctrl+V) if it doesn't load automatically"
      />
    </Box>
  );
};

export default DataProductInsights;
