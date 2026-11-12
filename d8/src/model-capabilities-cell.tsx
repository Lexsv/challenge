import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Box, ButtonBase, Paper, Popper, Typography } from '@mui/material';
import PlayArrowOutlined from '@mui/icons-material/PlayArrowOutlined';
import GraphicEq from '@mui/icons-material/GraphicEq';
import ImageOutlined from '@mui/icons-material/ImageOutlined';
import DescriptionOutlined from '@mui/icons-material/DescriptionOutlined';
import Title from '@mui/icons-material/Title';
import PsychologyOutlined from '@mui/icons-material/PsychologyOutlined';
import TerminalOutlined from '@mui/icons-material/TerminalOutlined';
import Check from '@mui/icons-material/Check';
import { compactCapabilities, modelCapabilityRows, type CapabilityKind, type ModelFeatures } from './model-capabilities';

const icons = { Video: PlayArrowOutlined, Audio: GraphicEq, Image: ImageOutlined, PDF: DescriptionOutlined, Text: Title, Reasoning: PsychologyOutlined, Tools: TerminalOutlined };
export function CapabilityIcon({kind}: {kind:CapabilityKind}) {
  const Icon = icons[kind];
  return <Icon aria-hidden="true" sx={{fontSize:18, flexShrink:0, color:'text.secondary'}} />;
}
type CardState = {model:string; rows:ReturnType<typeof modelCapabilityRows>; anchor:HTMLElement};
const CardContext = createContext<{show:(state:CardState)=>void;leave:()=>void;cancel:()=>void;active?:CardState}>({show:()=>{},leave:()=>{},cancel:()=>{}});
export function CapabilitiesCardProvider({children}:{children:ReactNode}) {
  const [active,setActive]=useState<CardState>();
  const timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  const cancel=()=>clearTimeout(timer.current);
  const leave=()=>{cancel();timer.current=setTimeout(()=>setActive(undefined),150)};
  useEffect(()=>()=>cancel(),[]);
  return <CardContext.Provider value={{active,show:state=>{cancel();setActive(state)},leave,cancel}}>{children}
    <Popper open={!!active} anchorEl={active?.anchor} placement="bottom-start" modifiers={[{name:'offset',options:{offset:[0,6]}},{name:'preventOverflow',options:{padding:8}}]} sx={{zIndex:1500}}>
      <Paper role="tooltip" aria-label={`Capabilities for ${active?.model}`} onMouseEnter={cancel} onMouseLeave={leave} variant="outlined" sx={{p:1.5,width:310,maxWidth:'calc(100vw - 24px)',boxShadow:3,bgcolor:'background.paper'}}>
        <Typography variant="subtitle2" sx={{mb:1}}>Capabilities</Typography>
        <Box role="list" sx={{display:'grid',gap:1}}>{active?.rows.map(row=><Box key={row.kind} role="listitem"><Box sx={{display:'grid',gridTemplateColumns:'18px 1fr auto',gap:1,alignItems:'center'}}><CapabilityIcon kind={row.kind}/><Typography variant="body2">{row.kind}</Typography>{row.value==='Supported'?<Check titleAccess="Supported" sx={{fontSize:18,color:'success.main'}}/>:<Typography variant="body2" color="text.secondary">{row.value}</Typography>}</Box>{!!row.levels?.length && <Typography variant="caption" color="text.secondary" sx={{display:'block',ml:'26px',mt:.25}}>Levels: {row.levels.join(', ')}</Typography>}</Box>)}</Box>
      </Paper>
    </Popper></CardContext.Provider>;
}
export function ModelCapabilitiesCell({model,features}: {model:string;features?:ModelFeatures}) {
  const context=useContext(CardContext);const rows=modelCapabilityRows(features);const {visible,remaining}=compactCapabilities(rows);
  if(!rows.length)return <Typography component="span" variant="body2" color="text.secondary">—</Typography>;
  return <ButtonBase aria-label={`Capabilities for ${model}: ${rows.map(r=>r.kind).join(', ')}`} aria-haspopup="dialog" aria-expanded={context.active?.model===model}
    onMouseEnter={e=>context.show({model,rows,anchor:e.currentTarget})} onMouseLeave={context.leave}
    onFocus={e=>context.show({model,rows,anchor:e.currentTarget})} onBlur={context.leave}
    onClick={e=>context.show({model,rows,anchor:e.currentTarget})} onKeyDown={e=>{if(e.key==='Escape'){e.currentTarget.blur();context.leave()}}}
    sx={{gap:.65,p:.5,borderRadius:1,minHeight:30,whiteSpace:'nowrap',color:'text.secondary','&:hover':{bgcolor:'action.hover'},'&.Mui-focusVisible':{outline:'2px solid',outlineColor:'primary.main',outlineOffset:2}}}>
    {visible.map(row=><CapabilityIcon key={row.kind} kind={row.kind}/>)}{remaining>0 && <Box component="span" sx={{fontSize:11,lineHeight:'18px',minWidth:23,px:.5,borderRadius:1,bgcolor:'action.selected',fontWeight:600}}>+{remaining}</Box>}
  </ButtonBase>;
}
