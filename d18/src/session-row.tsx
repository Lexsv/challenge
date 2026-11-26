import { Box, IconButton, ListItem, ListItemButton, ListItemText } from '@mui/material';
import MoreHoriz from '@mui/icons-material/MoreHoriz';

export function SessionRow({ id, title, owner = 'General', status, selected, menuOpen, disabled, onSelect, onActions }: {
  id: string; title: string; owner?: string; status?: string; selected: boolean; menuOpen: boolean; disabled: boolean;
  onSelect: () => void; onActions: (position: { x: number; y: number }) => void;
}) {
  return <ListItem disablePadding secondaryAction={
    <IconButton size="small" aria-label={`Actions for ${title}`} id={`session-actions-${id}`} aria-haspopup="menu"
      aria-controls={menuOpen ? 'session-actions-menu' : undefined} aria-expanded={menuOpen} disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        const bounds = event.currentTarget.getBoundingClientRect();
        onActions({ x: bounds.right, y: bounds.bottom });
      }}><MoreHoriz fontSize="small" /></IconButton>
  }>
    <ListItemButton selected={selected} aria-current={selected ? 'true' : undefined} disabled={disabled} onClick={onSelect}
      onContextMenu={(event) => { event.preventDefault(); if (!disabled) onActions({ x: event.clientX, y: event.clientY }); }}
      sx={{ border:1, borderColor:selected?"primary.light":"divider", borderRadius:1, my:0.5, pl:1.25, pr:5, minWidth:0 }}>
      <ListItemText sx={{ minWidth: 0 }} primary={title} secondary={status ? <>{owner}<br/><Box component="span" sx={{color:status==='Failed'?'error.main':status==='Active'?'success.main':'inherit'}}>● {status}</Box></> : owner} primaryTypographyProps={{ variant: 'body2', fontWeight: 700, noWrap: true, title }} secondaryTypographyProps={{ variant: 'caption', color: 'text.secondary', noWrap: true, title: owner }} />
    </ListItemButton>
  </ListItem>;
}
