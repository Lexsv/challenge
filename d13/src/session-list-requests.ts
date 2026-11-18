/** Applies only the latest request against unchanged session state. */
export class SessionListRequests {
  private generation=0;
  invalidate():void { this.generation++; }
  async load<T>(fetchList:()=>Promise<T>, onSuccess:(data:T)=>void, onFailure:()=>void):Promise<void> {
    const generation=++this.generation;
    try {
      const data=await fetchList();
      if(generation===this.generation) onSuccess(data);
    } catch {
      if(generation===this.generation) onFailure();
    }
  }
}
