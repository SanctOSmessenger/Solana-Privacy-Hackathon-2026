use anchor_lang::prelude::*;
use std::cmp::{max, min};

declare_id!("EBEQdAwgXmyLrj5npwmX63cEZwzrSKgEHy297Nfxrjhw");

#[program]
pub mod sanctos_messenger {
    use super::*;

    // -----------------------------
    // Legacy (Phantom popup) path
    // -----------------------------
    pub fn init_thread(ctx: Context<InitThread>) -> Result<()> {
        let thread = &mut ctx.accounts.thread;
        let clock = Clock::get()?;

        let user = ctx.accounts.user.key();
        let peer = ctx.accounts.peer.key();
        let (lower, higher) = sort_pair(user, peer);

        thread.bump = ctx.bumps.thread;
        thread.members = [lower, higher];
        thread.creator = user;
        thread.message_count = 0;
        thread.last_pointer = [0u8; 32];
        thread.closed = false;
        thread.created_at = clock.unix_timestamp;
        thread.updated_at = clock.unix_timestamp;

        Ok(())
    }

    pub fn post_pointer(ctx: Context<PostPointer>, pointer32: [u8; 32]) -> Result<()> {
        let thread = &mut ctx.accounts.thread;
        require!(!thread.closed, SanctosError::ThreadClosed);
    
        let sender = ctx.accounts.user.key();
        require!(thread.members.contains(&sender), SanctosError::NotMember);
    
        let clock = Clock::get()?;
        thread.message_count = thread.message_count.checked_add(1).unwrap();
        thread.last_pointer = pointer32;
        thread.updated_at = clock.unix_timestamp;
    
        // Derive owner/peer explicitly
        let user = ctx.accounts.user.key();
        let peer = ctx.accounts.peer.key();
        let (lower, higher) = sort_pair(user, peer);
        let owner = user;                // in legacy flow, owner == user
        let other = if owner == lower { higher } else { lower };
    
        emit!(MessagePosted {
            thread: thread.key(),
            owner,
            peer: other,
            sender: owner,
            delegate: Pubkey::default(),
            pointer32,
            index: thread.message_count,
            at: thread.updated_at,
        });
    
        Ok(())
    }
    

    // -----------------------------
    // Delegation: owner approves delegate once
    // -----------------------------
    pub fn set_delegate(ctx: Context<SetDelegate>, expires_at: i64) -> Result<()> {
        let auth = &mut ctx.accounts.auth;
        let now = Clock::get()?.unix_timestamp;

        require!(expires_at > now, SanctosError::BadExpiry);

        auth.bump = ctx.bumps.auth;
        auth.owner = ctx.accounts.owner.key();
        auth.delegate = ctx.accounts.delegate.key();
        auth.expires_at = expires_at;
        auth.revoked = false;

        Ok(())
    }

    pub fn revoke_delegate(ctx: Context<RevokeDelegate>) -> Result<()> {
        let auth = &mut ctx.accounts.auth;
        auth.revoked = true;
        Ok(())
    }

    // -----------------------------
    // Delegated (NO Phantom popup) paths
    // -----------------------------
    pub fn init_thread_delegated(ctx: Context<InitThreadDelegated>) -> Result<()> {
        let thread = &mut ctx.accounts.thread;
        let clock = Clock::get()?;

        // Validate delegation
        validate_delegate(
            &ctx.accounts.auth,
            &ctx.accounts.owner.key(),
            &ctx.accounts.delegate.key(),
        )?;

        let owner = ctx.accounts.owner.key();
        let peer = ctx.accounts.peer.key();
        let (lower, higher) = sort_pair(owner, peer);

        thread.bump = ctx.bumps.thread;
        thread.members = [lower, higher];
        thread.creator = owner; // creator is the Phantom wallet, not delegate
        thread.message_count = 0;
        thread.last_pointer = [0u8; 32];
        thread.closed = false;
        thread.created_at = clock.unix_timestamp;
        thread.updated_at = clock.unix_timestamp;

        Ok(())
    }

    pub fn post_pointer_delegated(
        ctx: Context<PostPointerDelegated>,
        pointer32: [u8; 32],
    ) -> Result<()> {
        let thread = &mut ctx.accounts.thread;
        require!(!thread.closed, SanctosError::ThreadClosed);
    
        // Validate delegation
        validate_delegate(
            &ctx.accounts.auth,
            &ctx.accounts.owner.key(),
            &ctx.accounts.delegate.key(),
        )?;
    
        // Owner must be one of the thread members
        let owner = ctx.accounts.owner.key();
        require!(thread.members.contains(&owner), SanctosError::NotMember);
    
        let clock = Clock::get()?;
        thread.message_count = thread.message_count.checked_add(1).unwrap();
        thread.last_pointer = pointer32;
        thread.updated_at = clock.unix_timestamp;
    
        let peer = ctx.accounts.peer.key();
        let (lower, higher) = sort_pair(owner, peer);
        let other = if owner == lower { higher } else { lower };
    
        emit!(MessagePosted {
            thread: thread.key(),
            owner,
            peer: other,
            sender: owner,                     // always logical sender
            delegate: ctx.accounts.delegate.key(),
            pointer32,
            index: thread.message_count,
            at: thread.updated_at,
        });
    
        Ok(())
    }
    
}

// ============================================================
// Accounts
// ============================================================

#[derive(Accounts)]
pub struct InitThread<'info> {
    #[account(mut)]
    pub user: Signer<'info>, // payer

    /// CHECK: second participant (not signer)
    pub peer: UncheckedAccount<'info>,

    #[account(
        init,
        payer = user,
        space = Thread::SPACE,
        seeds = [
            b"thread",
            min(user.key(), peer.key()).as_ref(),
            max(user.key(), peer.key()).as_ref(),
        ],
        bump
    )]
    pub thread: Account<'info, Thread>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PostPointer<'info> {
    #[account(mut)]
    pub user: Signer<'info>, // either member can post

    /// CHECK: other member
    pub peer: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [
            b"thread",
            min(user.key(), peer.key()).as_ref(),
            max(user.key(), peer.key()).as_ref(),
        ],
        bump = thread.bump
    )]
    pub thread: Account<'info, Thread>,
}

#[derive(Accounts)]
pub struct CloseThread<'info> {
    pub user: Signer<'info>,

    /// CHECK: other member
    pub peer: UncheckedAccount<'info>,

    #[account(
        mut,
        close = refund,
        seeds = [
            b"thread",
            min(user.key(), peer.key()).as_ref(),
            max(user.key(), peer.key()).as_ref(),
        ],
        bump = thread.bump,
        constraint = thread.members.contains(&user.key()) @ SanctosError::NotMember
    )]
    pub thread: Account<'info, Thread>,

    /// CHECK: rent refund destination
    #[account(mut)]
    pub refund: UncheckedAccount<'info>,
}

// ---- Delegation accounts ----

#[derive(Accounts)]
pub struct SetDelegate<'info> {
    #[account(mut)]
    pub owner: Signer<'info>, // Phantom wallet signs once

    /// CHECK: delegate pubkey (no need to sign in this instruction)
    pub delegate: UncheckedAccount<'info>,

    #[account(
        init,
        payer = owner,
        space = DelegateAuth::SPACE,
        seeds = [b"delegate", owner.key().as_ref(), delegate.key().as_ref()],
        bump
    )]
    pub auth: Account<'info, DelegateAuth>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RevokeDelegate<'info> {
    pub owner: Signer<'info>,

    /// CHECK: delegate pubkey
    pub delegate: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [b"delegate", owner.key().as_ref(), delegate.key().as_ref()],
        bump = auth.bump,
        constraint = auth.owner == owner.key() @ SanctosError::BadOwner
    )]
    pub auth: Account<'info, DelegateAuth>,
}

#[derive(Accounts)]
pub struct InitThreadDelegated<'info> {
    /// CHECK: Phantom wallet address (does NOT sign)
    pub owner: UncheckedAccount<'info>,

    /// CHECK: other participant
    pub peer: UncheckedAccount<'info>,

    #[account(mut)]
    pub delegate: Signer<'info>, // pays + signs tx

    #[account(
        seeds = [b"delegate", owner.key().as_ref(), delegate.key().as_ref()],
        bump = auth.bump
    )]
    pub auth: Account<'info, DelegateAuth>,

    #[account(
        init,
        payer = delegate,
        space = Thread::SPACE,
        seeds = [
            b"thread",
            min(owner.key(), peer.key()).as_ref(),
            max(owner.key(), peer.key()).as_ref(),
        ],
        bump
    )]
    pub thread: Account<'info, Thread>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PostPointerDelegated<'info> {
    /// CHECK: Phantom wallet address (does NOT sign)
    pub owner: UncheckedAccount<'info>,

    /// CHECK: other member
    pub peer: UncheckedAccount<'info>,

    #[account(mut)]
    pub delegate: Signer<'info>, // signs + pays

    #[account(
        seeds = [b"delegate", owner.key().as_ref(), delegate.key().as_ref()],
        bump = auth.bump
    )]
    pub auth: Account<'info, DelegateAuth>,

    #[account(
        mut,
        seeds = [
            b"thread",
            min(owner.key(), peer.key()).as_ref(),
            max(owner.key(), peer.key()).as_ref(),
        ],
        bump = thread.bump
    )]
    pub thread: Account<'info, Thread>,
}

// ============================================================
// State
// ============================================================

#[account]
pub struct Thread {
    pub bump: u8,
    pub members: [Pubkey; 2], // always sorted
    pub creator: Pubkey,      // who paid init (or owner, for delegated init)
    pub message_count: u64,
    pub last_pointer: [u8; 32],
    pub closed: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

impl Thread {
    pub const SPACE: usize = 8 + 1 + 32 * 3 + 8 + 32 + 1 + 8 + 8;
}

#[account]
pub struct DelegateAuth {
    pub bump: u8,
    pub owner: Pubkey,
    pub delegate: Pubkey,
    pub expires_at: i64,
    pub revoked: bool,
}

impl DelegateAuth {
    pub const SPACE: usize = 8 + 1 + 32 + 32 + 8 + 1;
}

#[event]
pub struct MessagePosted {
    pub thread: Pubkey,
    pub owner: Pubkey,      // Phantom wallet that “owns” the conversation
    pub peer: Pubkey,       // The other participant
    pub sender: Pubkey,     // Who is logically sending (usually == owner)
    pub delegate: Pubkey,   // Zero for non-delegated
    pub pointer32: [u8; 32],
    pub index: u64,
    pub at: i64,
}


#[error_code]
pub enum SanctosError {
    #[msg("Only thread members can perform this action.")]
    NotMember,
    #[msg("This thread is closed.")]
    ThreadClosed,

    #[msg("Delegation is revoked.")]
    DelegationRevoked,
    #[msg("Delegation has expired.")]
    DelegationExpired,
    #[msg("Invalid delegate for this owner.")]
    BadDelegate,
    #[msg("Invalid owner.")]
    BadOwner,
    #[msg("Expiry must be in the future.")]
    BadExpiry,
}

pub fn sort_pair(a: Pubkey, b: Pubkey) -> (Pubkey, Pubkey) {
    if a <= b {
        (a, b)
    } else {
        (b, a)
    }
}

fn validate_delegate(auth: &DelegateAuth, owner: &Pubkey, delegate: &Pubkey) -> Result<()> {
    require!(auth.owner == *owner, SanctosError::BadOwner);
    require!(auth.delegate == *delegate, SanctosError::BadDelegate);
    require!(!auth.revoked, SanctosError::DelegationRevoked);

    let now = Clock::get()?.unix_timestamp;
    require!(now < auth.expires_at, SanctosError::DelegationExpired);

    Ok(())
}
