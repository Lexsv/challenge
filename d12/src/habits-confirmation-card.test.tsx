import { describe,expect,it,vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { HabitsConfirmationCard, createHabitsDecision, decisionNotice, proposalIsActionable, scheduleProposalExpiry, type HabitsProposal } from './habits-confirmation-card';
import { ChatComposer } from './chat-composer';

const proposal:HabitsProposal={status:'confirmation_required',proposalId:'a'.repeat(43),expiresInMs:1000,changes:[
  {action:'ADD',after:'Use examples.'},
  {action:'UPDATE',before:'Be brief.',after:'Explain in detail.'},
  {action:'REMOVE',before:'Use greetings.'},
]};

describe('Habits confirmation card',()=>{
  it('expires at its deadline and cancels old timers',()=>{
    vi.useFakeTimers();
    try {
      const expired=vi.fn(),cancel=scheduleProposalExpiry(performance.now()+1000,expired);
      const deadline=performance.now()+1000;
      expect(proposalIsActionable(true,deadline)).toBe(true);
      expect(proposalIsActionable(false,deadline)).toBe(false);
      vi.advanceTimersByTime(999);expect(expired).not.toHaveBeenCalled();
      cancel();vi.advanceTimersByTime(1);expect(expired).not.toHaveBeenCalled();
      expect(proposalIsActionable(true,deadline)).toBe(false);
      expect(proposalIsActionable(true,performance.now()+500)).toBe(true);
      scheduleProposalExpiry(performance.now()+500,expired);
      vi.advanceTimersByTime(500);expect(expired).toHaveBeenCalledOnce();
    }finally{vi.useRealTimers();}
  });
  it('shows every operation compactly above the composer without a modal',()=>{
    const html=renderToStaticMarkup(<><div aria-label="conversation history">History</div><HabitsConfirmationCard proposal={proposal} pending={false} onDecision={()=>{}} /><ChatComposer draft="" onDraftChange={()=>{}} onSend={()=>{}} disabled={false} running={false} /></>);
    expect(html).toContain('Add: Use examples.');
    expect(html).toContain('Replace: Be brief. → Explain in detail.');
    expect(html).toContain('Remove: Use greetings.');
    expect(html).toContain('Discard');expect(html).toContain('Apply');
    expect(html.indexOf('conversation history')).toBeLessThan(html.indexOf('Profile instruction confirmation'));
    expect(html.indexOf('Profile instruction confirmation')).toBeLessThan(html.indexOf('<textarea'));
    expect(html).not.toContain('role="dialog"');
  });
  it('disables both actions while processing',()=>{
    const html=renderToStaticMarkup(<HabitsConfirmationCard proposal={proposal} pending onDecision={()=>{}} />);
    expect((html.match(/disabled=""/g) ?? [])).toHaveLength(2);
  });
  it.each(['accept','reject'] as const)('submits %s for its own session',async decision=>{
    const send=vi.fn().mockResolvedValue({status:decision==='accept'?'applied':'rejected',revision:2});
    const decide=createHabitsDecision('session-a',send);
    await decide(proposal.proposalId,decision);
    expect(send).toHaveBeenCalledWith('session-a',proposal.proposalId,decision);
  });
  it('prevents duplicate submissions and keeps sessions separate',async()=>{
    let release!:(value:{status:'applied';revision:number})=>void;
    const send=vi.fn().mockImplementation(()=>new Promise(resolve=>{release=resolve;}));
    const a=createHabitsDecision('session-a',send),b=createHabitsDecision('session-b',send);
    const first=a(proposal.proposalId,'accept');
    expect(await a(proposal.proposalId,'reject')).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
    release({status:'applied',revision:2});expect(await first).toEqual({status:'applied',revision:2});
    const next=b('b'.repeat(43),'reject');expect(send).toHaveBeenLastCalledWith('session-b','b'.repeat(43),'reject');
    release({status:'applied',revision:2});await next;
  });
  it('reports conflicts, expiry, and uncertain outcomes without a false save',async()=>{
    for(const status of ['expired_proposal','invalid_proposal','conflict','persistence_failure','unknown_commit','unknown'] as const)
      expect(decisionNotice(status)).not.toBe('Profile instructions saved.');
    expect(decisionNotice('conflict')).toContain('changed');
    expect(decisionNotice('expired_proposal')).toContain('expired');
    expect(decisionNotice('unknown')).toContain('could not be confirmed');
    expect(decisionNotice('applied')).toBe('Profile instructions saved.');
    expect(decisionNotice('rejected')).toBe('');
    const decide=createHabitsDecision('session',vi.fn().mockRejectedValue(Error('offline')));
    expect(await decide(proposal.proposalId,'accept')).toEqual({status:'unknown'});
  });
});
