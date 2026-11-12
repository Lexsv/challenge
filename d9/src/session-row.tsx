import { IconButton, ListItem, ListItemButton, ListItemText } from '@mui/material';
import MoreHoriz from '@mui/icons-material/MoreHoriz';

export function SessionRow({ id, title, selected, menuOpen, disabled, onSelect, onActions }: {
  id: string; title: string; selected: boolean; menuOpen: boolean; disabled: boolean;
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
    <ListItemButton selected={selected} aria-current={selected ? 'true' : undefined} onClick={onSelect}
      onContextMenu={(event) => { event.preventDefault(); if (!disabled) onActions({ x: event.clientX, y: event.clientY }); }}
      sx={{ borderRadius: 2, my: 0.5, pr: 6, minWidth: 0 }}>
      <ListItemText sx={{ minWidth: 0 }} primary={title} primaryTypographyProps={{ variant: 'body2', noWrap: true, title }} />
    </ListItemButton>
  </ListItem>;
}
