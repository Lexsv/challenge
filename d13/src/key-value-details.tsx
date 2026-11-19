import { useState } from 'react';
import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Typography } from '@mui/material';
import type { MemoryEntry } from './key-value-memory';

export function KeyValueDetails({ entries }: { entries: MemoryEntry[] }) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const close = () => { setOpen(false); setExpanded(null); };
  const toggle = (id: string) => setExpanded(current => current === id ? null : id);

  return <>
    <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2 }}>
      <Button variant="outlined" onClick={() => setOpen(true)}>Key-Value Details</Button>
    </Box>
    <Dialog open={open} onClose={close} fullWidth maxWidth="md" aria-labelledby="key-value-details-title">
      <DialogTitle id="key-value-details-title">Key-Value Details</DialogTitle>
      <DialogContent>
        <Box component="table" aria-label="Stored memory" sx={{ width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse', textAlign: 'left' }}>
          <Box component="colgroup"><col style={{ width: '38%' }} /><col /></Box>
          <Box component="thead" sx={{ bgcolor: 'primary.light' }}><tr><Box component="th" sx={{ p: 1.25 }}>Key</Box><Box component="th" sx={{ p: 1.25 }}>Value</Box></tr></Box>
          <Box component="tbody">
            {entries.map(entry => {
              const isExpanded = expanded === entry.id;
              const cell = { height: isExpanded ? '7.5em' : '1.5em', lineHeight: 1.5, overflowY: isExpanded ? 'auto' : 'hidden', overflowX: 'hidden', whiteSpace: isExpanded ? 'pre-wrap' : 'nowrap', textOverflow: isExpanded ? 'clip' : 'ellipsis', overflowWrap: 'anywhere', transition: 'height 200ms ease', '@media (prefers-reduced-motion: reduce)': { transition: 'none' } } as const;
              return <Box component="tr" key={entry.id} tabIndex={0} aria-expanded={isExpanded} onClick={() => toggle(entry.id)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(entry.id); } }} sx={{ cursor: 'pointer', borderBottom: 1, borderColor: 'divider', '&:hover': { bgcolor: 'action.hover' }, '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.dark', outlineOffset: -2 } }}>
                <Box component="td" sx={{ p: 1.25, verticalAlign: 'top', color: 'primary.dark' }}><Box sx={cell}>{entry.key}</Box></Box>
                <Box component="td" sx={{ p: 1.25, verticalAlign: 'top' }}><Box sx={cell}>{entry.value}</Box></Box>
              </Box>;
            })}
          </Box>
        </Box>
        {!entries.length && <Typography color="text.secondary" sx={{ mt: 2 }}>No saved topics yet.</Typography>}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2, pt: 1 }}><Button variant="outlined" onClick={close}>Close</Button></DialogActions>
    </Dialog>
  </>;
}
