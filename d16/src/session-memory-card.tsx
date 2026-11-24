import { useId, useState } from 'react';
import { Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, Paper, Stack, Tab, Tabs, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Tooltip, Typography } from '@mui/material';
import ChevronRight from '@mui/icons-material/ChevronRight';
import InfoOutlined from '@mui/icons-material/InfoOutlined';
import type { MemoryData, MemorySnapshot } from './session-memory';

type Category = 'short' | 'summary' | 'facts';
type Item = { id: Category; label: string; description:string; color: string; tokens?: number };
const colors: Record<Category,string> = {short:'#b9caef',summary:'#d6c5ec',facts:'#bde1d5'};
const format = (value?: number) => value === undefined ? '—' : value.toLocaleString('en-US');

type LongTermView = 'preview' | 'raw';
export function LongTermMemoryView({facts,view}:{facts:MemoryData['facts'];view:LongTermView}) {
  if(view==='raw')return <Box component="pre" tabIndex={0} aria-label="Raw fact JSON" sx={{m:0,p:1.5,bgcolor:'grey.50',border:1,borderColor:'divider',borderRadius:1,overflow:'auto',maxHeight:'55vh',fontFamily:'monospace',fontSize:12}}>{JSON.stringify(facts,null,2)}</Box>;
  if(!facts.length)return <Typography color="text.secondary">No key facts yet.</Typography>;
  return <TableContainer component={Paper} variant="outlined" tabIndex={0} aria-label="Long-term memory facts" sx={{maxHeight:'55vh',overflow:'auto'}}><Table size="small" stickyHeader sx={{minWidth:500,tableLayout:'fixed'}}><TableHead><TableRow>{['Subject','Attribute','Value','Status'].map(label=><TableCell key={label} sx={{fontWeight:700}}>{label}</TableCell>)}</TableRow></TableHead><TableBody>{facts.map((fact,index)=><TableRow key={index}><TableCell sx={{overflowWrap:'anywhere',whiteSpace:'pre-wrap'}}>{fact.subject}</TableCell><TableCell sx={{overflowWrap:'anywhere',whiteSpace:'pre-wrap'}}>{fact.attribute}</TableCell><TableCell sx={{overflowWrap:'anywhere',whiteSpace:'pre-wrap'}}>{fact.value}</TableCell><TableCell><Chip size="small" variant="outlined" label={fact.status ?? '—'} sx={{textTransform:'capitalize'}} /></TableCell></TableRow>)}</TableBody></Table></TableContainer>;
}

function LongTermMemoryDetails({facts}:{facts:MemoryData['facts']}) {
  const [view,setView]=useState<LongTermView>('preview');
  const id=useId();
  return <Box><Tabs value={view} onChange={(_event,next:LongTermView)=>setView(next)} aria-label="Long-term memory display" sx={{mb:1.5}}><Tab label="Preview" value="preview" id={`${id}-preview`} aria-controls={`${id}-panel`} /><Tab label="Raw JSON" value="raw" id={`${id}-raw`} aria-controls={`${id}-panel`} /></Tabs><Box role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${view}`}><LongTermMemoryView facts={facts} view={view} /></Box></Box>;
}

export function MemoryDetailsContent({category,data}:{category:Category;data:MemoryData | null}) {
  const messages=data?.short.flatMap(group=>group.messages) ?? [];
  if(category==='short') return messages.length ? <Stack spacing={1}>{messages.map((message,index)=><Paper key={index} variant="outlined" sx={{p:1.5,overflowWrap:'anywhere'}}><Typography variant="caption" sx={{fontWeight:700,textTransform:'capitalize'}}>{message.role}</Typography><Typography variant="body2" sx={{whiteSpace:'pre-wrap'}}>{message.content}</Typography>{(message.toolCalls?.length || message.toolName || message.toolCallId) ? <Box component="pre" sx={{m:0,whiteSpace:'pre-wrap',overflowWrap:'anywhere',fontSize:12}}>{JSON.stringify({toolCalls:message.toolCalls,toolName:message.toolName,toolCallId:message.toolCallId},null,2)}</Box> : null}</Paper>)}</Stack> : <Typography color="text.secondary">No short-term messages.</Typography>;
  if(category==='summary') return <Typography variant="body2" sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{data?.summary || 'No summary yet.'}</Typography>;
  return <LongTermMemoryDetails facts={data?.facts ?? []} />;
}

export function SessionMemoryCard({snapshot,shortTokens,shortLimit,summaryTokens,factTokens}:{snapshot?:MemorySnapshot;shortTokens?:number;shortLimit?:number;summaryTokens?:number;factTokens?:number}) {
  const [selected,setSelected] = useState<Category | null>(null);
  const [info,setInfo] = useState<Category | null>(null);
  const titleId=useId();
  const data=snapshot?.data;
  // Empty layers have zero content; pending or unavailable estimates stay unknown.
  const items:Item[]=[
    {id:'short',label:'Short-term memory',description:'Recent conversation messages kept in their original form. Older messages may be summarized when the buffer reaches its limit.',color:colors.short,tokens:snapshot ? shortTokens : undefined},
    {id:'summary',label:'Medium-term memory',description:'Compressed summaries of earlier conversations. Preserves important context while reducing token usage.',color:colors.summary,tokens:snapshot ? (summaryTokens ?? (!data?.summary ? 0 : undefined)) : undefined},
    {id:'facts',label:'Long-term memory',description:'Persistent key facts extracted from conversations, including updates and version history.',color:colors.facts,tokens:snapshot ? (factTokens ?? (!data?.facts.length ? 0 : undefined)) : undefined},
  ];
  const chosen=items.find(item=>item.id===selected);
  const complete=items.every(item=>item.tokens!==undefined);
  const total=complete ? items.reduce((sum,item)=>sum+item.tokens!,0) : undefined;
  const circumference=2*Math.PI*42;
  let offset=0;
  const segments=items.map(item=>{const fraction=total && item.tokens ? item.tokens/total : 0;const start=offset;offset+=fraction;return {...item,fraction,start};});
  return <Paper component="section" variant="outlined" aria-label="Session Memory" sx={{p:1.5,mt:1.5,minWidth:0,borderColor:'divider',borderRadius:2}}>
    <Typography component="h3" variant="h6" sx={{fontWeight:700}}>Session Memory</Typography>
    <Box sx={{position:'relative',width:160,height:160,mx:'auto',my:1}}>
      <Box component="svg" viewBox="0 0 100 100" width="100%" height="100%" aria-label="Memory token distribution" sx={{'& [role="button"]:focus-visible':{outline:'2px solid #425c83',outlineOffset:2}}}>
        <circle cx="50" cy="50" r="42" fill="none" stroke="#edf1f5" strokeWidth="12" />
        {complete && !!total && segments.filter(item=>item.fraction>0).map(item=><circle key={item.id} cx="50" cy="50" r="42" fill="none" stroke={item.color} strokeWidth="12" strokeDasharray={`${item.fraction*circumference} ${circumference}`} strokeDashoffset={-item.start*circumference} transform="rotate(-90 50 50)" role="button" tabIndex={0} aria-label={`Open ${item.label} details`} onClick={()=>setSelected(item.id)} onKeyDown={event=>{if(event.key==='Enter' || event.key===' '){event.preventDefault();setSelected(item.id);}}} style={{cursor:'pointer'}} />)}
      </Box>
      <Box sx={{position:'absolute',inset:0,display:'flex',alignItems:'center',justifyContent:'center',flexDirection:'column',pointerEvents:'none'}}><Typography variant="h6" sx={{fontWeight:700}}>{format(total)}</Typography><Typography variant="caption" color="text.secondary">context estimates</Typography></Box>
    </Box>
    {!complete && <Typography variant="caption" color="text.secondary" sx={{display:'block',textAlign:'center',mb:1}}>{snapshot ? 'Distribution unavailable: some token estimates are unavailable or still loading.' : 'Memory data is unavailable or still loading.'}</Typography>}
    <Stack spacing={.5}>{items.map(item=><Stack key={item.id} direction="row" alignItems="center"><Button fullWidth variant="text" color="inherit" onClick={()=>setSelected(item.id)} aria-label={`Open ${item.label} details`} sx={{justifyContent:'flex-start',textAlign:'left',textTransform:'none',px:1,py:.75,borderRadius:1.5,'&:focus-visible':{outline:'2px solid',outlineColor:'primary.main',outlineOffset:2}}}>
      <Box aria-hidden="true" sx={{width:10,height:10,borderRadius:'50%',bgcolor:item.color,mr:1,flexShrink:0}} />
      <Typography component="span" variant="body2" sx={{flex:1,fontWeight:600}}>{item.label}</Typography>
      <Typography component="span" variant="body2" color="text.secondary" sx={{whiteSpace:'nowrap'}}>{format(item.tokens)}{item.id==='short' && shortLimit!==undefined ? ` / ${format(shortLimit)}` : ''} tokens</Typography>
      <ChevronRight aria-hidden="true" fontSize="small" sx={{ml:.5,color:'text.secondary'}} />
    </Button><Tooltip title={item.description} placement="top" slotProps={{tooltip:{sx:{maxWidth:260,whiteSpace:'normal',overflowWrap:'anywhere'}}}} open={info===item.id} onOpen={()=>setInfo(item.id)} onClose={()=>setInfo(null)} describeChild><IconButton size="small" aria-label={`About ${item.label}`} onClick={event=>{event.stopPropagation();setInfo(item.id);}} sx={{'&:focus-visible':{outline:'2px solid',outlineColor:'primary.main',outlineOffset:2}}}><InfoOutlined fontSize="small" /></IconButton></Tooltip></Stack>)}</Stack>
    {!!data?.buffer.length && <Typography variant="caption" color="text.secondary">{data.buffer.length} conversation groups await compression.</Typography>}
    <Dialog open={selected!==null} onClose={()=>setSelected(null)} aria-labelledby={titleId} fullWidth maxWidth="sm" scroll="paper">
      <DialogTitle id={titleId}>{chosen?.label}</DialogTitle>
      <DialogContent dividers sx={{overflowY:'auto'}}>
        <Typography variant="body2" color="text.secondary" sx={{mb:2}}>{format(chosen?.tokens)}{selected==='short' && shortLimit!==undefined ? ` / ${format(shortLimit)}` : ''} estimated tokens</Typography>
        {!snapshot && <Typography color="text.secondary">Memory data is unavailable or still loading.</Typography>}
        {snapshot && selected && <MemoryDetailsContent category={selected} data={data ?? null} />}
      </DialogContent>
      <DialogActions><Button onClick={()=>setSelected(null)}>Close</Button></DialogActions>
    </Dialog>
  </Paper>;
}
