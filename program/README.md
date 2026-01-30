# SanctOS Messenger Program (Solana / Anchor)

SanctOS is a privacy-first messenger on Solana.

**Core idea:** the chain is used only for *coordination + ordering + authorization* — **not** for message storage.
Messages are encrypted client-side and referenced on-chain using a fixed-size pointer.

Program ID (mainnet): `EBEQdAwgXmyLrj5npwmX63cEZwzrSKgEHy297Nfxrjhw`  
Memo Program (v2): `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`

---

## What goes on-chain vs off-chain

### ✅ On-chain (this program)
- A deterministic **Thread PDA** for each 1:1 conversation.
- A **32-byte pointer** (`pointer32`) representing the latest message reference.
- A monotonically increasing `message_count` and timestamps.
- Optional **delegation authorization** (owner approves a delegate signer, revocable + time-bounded).
- An emitted **event** (`MessagePosted`) that indexers/clients can read to reconstruct message order.

### ❌ Not on-chain
- No plaintext messages.
- No encryption keys.
- No ability for validators/RPCs to decrypt content.
- No per-message message bodies stored in program accounts.

---

## Data model

### Thread PDA
A thread is a PDA derived from the two participant wallets, always sorted so the address is stable regardless of sender:

Seeds:
- `["thread", min(owner, peer), max(owner, peer)]`

Stored fields (simplified):
- `members: [Pubkey; 2]` (sorted)
- `creator: Pubkey` (who initialized; in delegated init this is the *owner*)
- `message_count: u64`
- `last_pointer: [u8; 32]`
- `closed: bool`
- `created_at`, `updated_at`

### DelegateAuth PDA (optional)
Delegation is a PDA derived from `(owner, delegate)`:

Seeds:
- `["delegate", owner, delegate]`

Stored fields:
- `owner: Pubkey`
- `delegate: Pubkey`
- `expires_at: i64` (unix seconds)
- `revoked: bool`

Delegation is:
- ✅ explicitly created by the owner once (`set_delegate`)
- ✅ time-bounded (`expires_at`)
- ✅ revocable (`revoke_delegate`)
- ✅ checked on every delegated instruction

---

## Instruction design

SanctOS supports two posting modes:

### 1) Manual (wallet-signed) flow — “legacy / Phantom popup”
This is the simplest path: the user wallet signs and pays.

- `init_thread(user, peer)`  
  Creates the Thread PDA (if it doesn’t exist).

- `post_pointer(user, peer, pointer32)`  
  Updates the thread state with the latest pointer and emits `MessagePosted`.

**Authorization:**
- `user` must be one of the thread members.

**What this enables:**
- Traditional “wallet signs to post” messaging.

---

### 2) Delegated (autosign) flow — “no Phantom popup”
This path allows a pre-approved **delegate key** to sign and pay on behalf of the owner.

- `set_delegate(owner, delegate, expires_at)`  
  Owner signs once to create `DelegateAuth` PDA.

- `init_thread_delegated(owner, peer, delegate)`  
  Delegate signs/pays, but thread creator is still the owner.

- `post_pointer_delegated(owner, peer, delegate, pointer32)`  
  Delegate signs/pays; program validates delegation; updates thread; emits `MessagePosted` including the delegate pubkey.

**Authorization:**
- The program checks the `DelegateAuth` PDA:
  - correct owner
  - correct delegate
  - not revoked
  - not expired
- Owner must be a member of the thread.

**What this enables:**
- A “hot delegate key” can do message posting without user wallet popups,
  while the owner retains control and can revoke/expire authorization.

---

## How messages are actually transported (Memo + pointer)

SanctOS uses the **Memo Program v2** for lightweight, indexable metadata.  
A typical message transaction includes:

1) **Memo instruction** (contains a `SANCTOS_MSG:...` payload)
2) **Fee transfer** (small SOL transfer for economics / anti-spam)
3) **Program instruction** (updates the Thread PDA with `pointer32`)
4) (Optional) additional guard rails (ex: Lighthouse assertions)

The **message content** is never placed on-chain in plaintext.
Clients:
- encrypt locally
- generate a compact reference/pointer
- post the pointer + memo for discovery/indexing
- decrypt locally when syncing

---

## Real transactions (examples)

### Manual (wallet-signed) tx
Solscan: https://solscan.io/tx/4BrZcLJr7hbWWhkN2VyvxrpKQpMWSVfrLkE3GCTvkv61HUXXGjfTyhMTaJM5uqaTH3E7QNcRegsnNagkp2sEiYGC

Observed structure:
- Memo v2: `SANCTOS_MSG:<peer>:<payload>`
- System transfer (fee)
- SanctOS program call (Thread update)

### Delegate (autosign) tx
Solscan: https://solscan.io/tx/2TCmNDvkhiiuCPFg7ydME1hwFtWuykvfK23dhEShTQdgPMXBrUxjVF1HH6E8iMWfE63ApVPNw2vFrjk9c3KPswcM

Observed structure:
- Memo v2: `SANCTOS_MSG:<peer>:<payload>`
- System transfer (fee paid by delegate signer)
- SanctOS program call (Thread update authorized via `DelegateAuth`)

---

## Why this design

- **Privacy-first:** chain only stores pointers + authorization, not message bodies.
- **Deterministic threads:** stable PDA means easy discovery, indexing, and sync.
- **Delegate UX:** enables “Signal-like” smoothness (no popups) while keeping owner control.
- **Composable:** any external app can read memos + events and build clients/indexers without an IDL.

---

## Security notes (high-level)

- Delegation is scoped to `(owner, delegate)` and enforced by PDA verification.
- Delegation is time-bounded and revocable.
- Thread membership checks prevent non-members from mutating a thread.
- No secrets ever touch the chain.