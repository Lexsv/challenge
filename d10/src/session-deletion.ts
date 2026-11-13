export type SessionDeletionTarget = { id: string; title: string };
export class SessionDeletion {
  private state: { target: SessionDeletionTarget | null; pending: boolean; error: string } = { target: null, pending: false, error: '' };
  private listeners = new Set<() => void>();
  constructor(private remove: (id: string) => Promise<void>, private onDeleted: (id: string) => void) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.state;
  private set(state: typeof this.state) { this.state = state; this.listeners.forEach((listener) => listener()); }
  request(target: SessionDeletionTarget) { if (!this.state.pending) this.set({ target, pending: false, error: '' }); }
  cancel() { if (!this.state.pending) this.set({ target: null, pending: false, error: '' }); }
  async confirm(): Promise<boolean> {
    const target = this.state.target;
    if (!target || this.state.pending) return false;
    this.set({ target, pending: true, error: '' });
    try {
      await this.remove(target.id);
      this.onDeleted(target.id);
      this.set({ target: null, pending: false, error: '' });
      return true;
    } catch {
      this.set({ target, pending: false, error: 'Could not delete this session. Its row has been kept. Retry deletion.' });
      return false;
    }
  }
}
