import React, { useState } from 'react';
import { Box, Collapse, IconButton, Tooltip, Typography } from '@mui/material';
import { ExpandMore, ExpandLess, ContentCopy, Code } from '@mui/icons-material';
import { Highlight, themes } from 'prism-react-renderer';

interface SqlQueryBlockProps {
  sql: string;
  /** Start expanded. Defaults to collapsed (a dropdown the user opens). */
  defaultOpen?: boolean;
}

/**
 * A collapsible "View SQL query" dropdown used in the chat. Shows the SQL the
 * backend generated for an answer, with syntax highlighting and a copy button.
 */
const SqlQueryBlock: React.FC<SqlQueryBlockProps> = ({ sql, defaultOpen = false }) => {
  const [open, setOpen] = useState(defaultOpen);
  const [copied, setCopied] = useState(false);

  if (!sql || !sql.trim()) return null;

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(sql);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore clipboard errors */
    }
  };

  return (
    <Box sx={{ mt: 1.5, border: '1px solid #DADCE0', borderRadius: '8px', overflow: 'hidden' }}>
      <Box
        onClick={() => setOpen((v) => !v)}
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          px: 1.5,
          py: 1,
          cursor: 'pointer',
          backgroundColor: open ? '#f1f3f4' : 'transparent',
          '&:hover': { backgroundColor: '#f1f3f4' },
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Code sx={{ fontSize: '1.1rem', color: '#1a73e8' }} />
          <Typography sx={{ fontSize: '0.8rem', fontWeight: 600, color: '#3c4043', fontFamily: 'Google Sans, sans-serif' }}>
            View SQL query
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center' }}>
          {open && (
            <Tooltip title={copied ? 'Copied!' : 'Copy SQL'}>
              <IconButton size="small" onClick={handleCopy} sx={{ color: copied ? '#34a853' : '#5f6368' }}>
                <ContentCopy sx={{ fontSize: '1rem' }} />
              </IconButton>
            </Tooltip>
          )}
          {open ? <ExpandLess sx={{ color: '#5f6368' }} /> : <ExpandMore sx={{ color: '#5f6368' }} />}
        </Box>
      </Box>
      <Collapse in={open}>
        <Highlight theme={themes.nightOwlLight} code={sql.trim()} language="sql">
          {({ className, style, tokens, getLineProps, getTokenProps }) => (
            <Box
              component="pre"
              className={className}
              sx={{
                ...style,
                px: 1.5,
                py: 1,
                margin: 0,
                fontSize: '0.78rem',
                lineHeight: 1.5,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                overflowX: 'auto',
              }}
            >
              {tokens.map((line, i) => (
                <div {...getLineProps({ line, key: i })}>
                  {line.map((token, key) => (
                    <span {...getTokenProps({ token, key })} />
                  ))}
                </div>
              ))}
            </Box>
          )}
        </Highlight>
      </Collapse>
    </Box>
  );
};

export default SqlQueryBlock;
