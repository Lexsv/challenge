/** Ignore repeated verification actions until the active action settles. */
export function createVerificationSingleFlight() {
  let pending = false;
  return async (action: () => Promise<void>): Promise<boolean> => {
    if (pending) return false;
    pending = true;
    try { await action(); return true; }
    finally { pending = false; }
  };
}
