import { useEffect, useState } from "react";
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Typography } from "@mui/material";

type Proposal = { id: string; service: string; tool: string; reviewableRead?: boolean; arguments: unknown };

export function McpOperationReview({base, runId}: {base: string; runId: string}) {
  const url = base + "/mcp-review/" + encodeURIComponent(runId);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  async function request(body: object, signal?: AbortSignal) {
    const response = await fetch(url, {method:"POST", cache:"no-store", signal,
      headers:{"Content-Type":"application/json","X-Day16-UI":"review"}, body:JSON.stringify(body)});
    if (!response.ok) throw Error();
    return (await response.json()).review;
  }
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await request({},controller.signal);
        if (!controller.signal.aborted) { setProposal(next); setError(""); }
      } catch {
        if (!controller.signal.aborted) setError("Could not check for a tool approval. Reconnecting…");
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(poll, 1000);
      }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [url]);
  async function decide(decision: "approve" | "deny" | "remember-read") {
    if (!proposal || sending) return;
    setSending(true);
    try {
      await request({id:proposal.id, decision});
      setProposal(null);
    } catch { setError("This decision could not be confirmed. Checking its current status…"); }
    finally { setSending(false); }
  }
  if (!proposal) return error ? <Alert severity="warning">{error}</Alert> : null;
  return <Dialog open fullWidth maxWidth="md" aria-labelledby="review-mcp-title">
    <DialogTitle id="review-mcp-title">Review tool operation</DialogTitle>
    <DialogContent dividers>
      <Typography fontWeight={600}>{proposal.service} · {proposal.tool}</Typography>
      <Typography variant="body2">Review the generated arguments. Approving allows this call to run once and may change data on the connected service.</Typography>
      <Box component="pre" dir="ltr" sx={{whiteSpace:"pre-wrap", overflowWrap:"anywhere", unicodeBidi:"isolate", fontSize:"0.85rem"}}>
        {JSON.stringify(proposal.arguments,null,2)}
      </Box>
      {proposal.reviewableRead && <Typography variant="body2">
        If you have verified that this operation only reads data, you can allow these exact arguments for this session. Detaching the connection clears this permission.
      </Typography>}
      {error && <Alert severity="warning">{error}</Alert>}
    </DialogContent>
    <DialogActions>
      <Button autoFocus disabled={sending} onClick={()=>void decide("deny")}>Decline</Button>
      {proposal.reviewableRead && <Button disabled={sending} onClick={()=>void decide("remember-read")}>Allow this read in this session</Button>}
      <Button variant="contained" disabled={sending} onClick={()=>void decide("approve")}>Approve once</Button>
    </DialogActions>
  </Dialog>;
}
