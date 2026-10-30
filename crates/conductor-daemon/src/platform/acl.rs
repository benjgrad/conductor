//! Port of `packages/daemon/src/platform/acl.ts` (MR-T04). MW-T04, ADR-0024 §3, ADR-0010: private
//! files and dirs on every OS.
//!
//! POSIX keeps the TS logic and messages: files 0600, dirs 0700, lstat (no symlinks), owner uid,
//! and `mode & 0o077` on files.
//!
//! Windows has no useful mode bits, so (ADR-0026: native calls, no icacls or PowerShell):
//! - write: a new file or dir is created with an owner-only security descriptor already on it
//!   (owner = the user; a protected DACL granting full control to the user, SYSTEM and
//!   Administrators; dirs `(OI)(CI)` so children start owner-only too), so there is no
//!   inherited-permission window at all. An existing dir is restricted with `SetSecurityInfo`.
//! - verify: the owner, DACL and SDDL are read from one handle opened on the path itself (a link
//!   or junction is refused, never followed), and judged by [`evaluate_win_acl`], the same rules
//!   as `acl.ts`: a foreign owner, inheritance, or any allow-ACE for a SID outside {user, SYSTEM,
//!   Administrators} is refused; any ACE that isn't a plain allow/deny (conditional, callback,
//!   object) is refused; the SDDL, the raw DACL's ACE count and the plain ACEs must agree, else
//!   the ACL counts as unreadable. Anything that can't be read is refused.
//! - the TS refusals stay (tested): a private file is only written into a dir that already passes
//!   the check, and `mkdir_private` only creates under an owner-only ancestor or directly under the
//!   user's profile dir or %LOCALAPPDATA% (per-user by default).
//! - no cache of verified dirs: a native read costs microseconds, where Get-Acl cost a second.

use std::fmt;
use std::io;
use std::path::Path;

/// SYSTEM.
pub const SID_SYSTEM: &str = "S-1-5-18";
/// BUILTIN\Administrators.
pub const SID_ADMINISTRATORS: &str = "S-1-5-32-544";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AclKind {
    File,
    Dir,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AclRefusal {
    /// A symlink or junction, or not the requested kind.
    WrongType,
    ForeignOwner,
    /// POSIX group/other mode bits, or a Windows allow-ACE for another SID.
    TooOpen,
    /// Windows: the DACL inherits from the parent.
    Inherited,
    /// Windows: the ACL (or the current user's SID) could not be read.
    Unreadable,
}

impl AclRefusal {
    /// The TS reason string.
    pub fn as_str(self) -> &'static str {
        match self {
            AclRefusal::WrongType => "wrong-type",
            AclRefusal::ForeignOwner => "foreign-owner",
            AclRefusal::TooOpen => "too-open",
            AclRefusal::Inherited => "inherited",
            AclRefusal::Unreadable => "unreadable",
        }
    }
}

/// A refused private path. `reason` lets call sites keep their own wording if they need to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AclError {
    pub reason: AclRefusal,
    pub message: String,
    /// Windows `ForeignOwner`: the owner SID found.
    pub owner: Option<String>,
}

impl AclError {
    pub fn new(reason: AclRefusal, message: impl Into<String>) -> Self {
        AclError {
            reason,
            message: message.into(),
            owner: None,
        }
    }
}

impl fmt::Display for AclError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for AclError {}

/// Why a private-path operation failed: a refusal, or the file system (a missing path is
/// `Io(NotFound)`, as the TS daemon throws the raw ENOENT).
#[derive(Debug, thiserror::Error)]
pub enum PrivateError {
    #[error(transparent)]
    Acl(#[from] AclError),
    #[error(transparent)]
    Io(#[from] io::Error),
}

impl PrivateError {
    /// The refusal, if it is one.
    pub fn acl(&self) -> Option<&AclError> {
        match self {
            PrivateError::Acl(a) => Some(a),
            PrivateError::Io(_) => None,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct AssertOwnerOnlyOptions {
    pub kind: AclKind,
    /// Also check who else can access it (POSIX file mode, Windows DACL + inheritance). False
    /// checks only the type and the owner: `credential` vetting a file it is about to replace.
    /// POSIX never mode-checks a dir (ADR-0010 checks only its owner); Windows checks a dir's DACL
    /// (ADR-0024 §3).
    pub check_access: bool,
}

impl AssertOwnerOnlyOptions {
    pub fn new(kind: AclKind) -> Self {
        AssertOwnerOnlyOptions {
            kind,
            check_access: true,
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Public API

/// The current user's SID, cached for the process. Windows only: errs elsewhere.
pub fn current_user_sid() -> Result<String, AclError> {
    imp::current_user_sid()
}

/// Write `data` to `path` atomically, readable only by this user: a temp file next to it, private
/// before it holds any data, then renamed over `path`. The parent must exist.
pub fn write_private_file(path: &Path, data: &[u8]) -> Result<(), PrivateError> {
    let tmp = format!(
        "{}.{}.tmp",
        path.to_string_lossy(),
        hex::encode(rand::random::<[u8; 6]>())
    );
    imp::write_private_file(path, Path::new(&tmp), data)
}

/// Create `path` (and any missing parents) and make it private: refuse it if it is a symlink, not
/// a directory, or owned by someone else, then chmod 0700 (POSIX) or apply the owner-only DACL and
/// verify it (Windows).
pub fn mkdir_private(path: &Path) -> Result<(), PrivateError> {
    imp::mkdir_private(path)
}

/// Refuse `path` unless it is a real file/dir (lstat: no symlink, no junction) owned by this user
/// and, with `check_access`, private to it. A missing path is `Io(NotFound)`.
pub fn assert_owner_only(path: &Path, opts: AssertOwnerOnlyOptions) -> Result<(), PrivateError> {
    imp::assert_owner_only(path, opts)
}

/// Windows: the owner and DACL of `path` as SIDs. Errs (`Unreadable`) on POSIX.
pub fn read_win_acl(path: &Path) -> Result<WinAcl, AclError> {
    imp::read_win_acl(path)
}

/// The type check shared by both OSes (lstat; a junction counts as a symlink).
fn assert_type(path: &Path, meta: &std::fs::Metadata, kind: AclKind) -> Result<(), AclError> {
    let p = path.display();
    if super::fs::is_reparse_point(meta) {
        return Err(AclError::new(
            AclRefusal::WrongType,
            format!("{p} is a symlink; refusing to use it"),
        ));
    }
    if kind == AclKind::Dir && !meta.is_dir() {
        return Err(AclError::new(
            AclRefusal::WrongType,
            format!("{p} is not a directory"),
        ));
    }
    if kind == AclKind::File && !meta.is_file() {
        return Err(AclError::new(
            AclRefusal::WrongType,
            format!("{p} is not a regular file"),
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Pure parsing and decisions (tested on every OS)

/// One plain DACL ACE (what .NET's GetAccessRules showed): allow or deny, for a SID.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WinRule {
    pub sid: String,
    pub allow: bool,
    pub inherited: bool,
}

/// The owner and DACL of a Windows path. `rules` holds the plain allow/deny ACEs only;
/// `ace_count` is the raw DACL's ACE count (-1 for a NULL DACL) and `sddl` the owner + DACL in SDDL,
/// which together expose any ACE `rules` leaves out.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WinAcl {
    pub owner: String,
    pub protected: bool,
    pub rules: Vec<WinRule>,
    pub sddl: String,
    pub ace_count: i64,
}

/// One DACL ACE from an SDDL string: its type (`A`, `D`, `XA`, ...), flags and raw trustee.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SddlAce {
    pub ace_type: String,
    pub flags: String,
    pub sid: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedSddl {
    pub owner: Option<String>,
    /// DACL flags, e.g. `PAI`; contains `NO_ACCESS_CONTROL` for a NULL DACL.
    pub dacl_flags: String,
    pub null_dacl: bool,
    pub aces: Vec<SddlAce>,
}

fn is_sid(s: &str) -> bool {
    // /^S-1-\d+(-\d+)+$/i
    let Some(rest) = s
        .get(..4)
        .filter(|p| p.eq_ignore_ascii_case("S-1-"))
        .map(|_| &s[4..])
    else {
        return false;
    };
    let parts: Vec<&str> = rest.split('-').collect();
    parts.len() >= 2
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
}

/// Parse the owner and DACL of an SDDL string. An ACE body is split on its first five `;` only,
/// so a conditional expression (7th field, with its own parentheses) is skipped, not parsed. Errs
/// on anything malformed (callers fail closed).
pub fn parse_sddl(sddl: &str) -> Result<ParsedSddl, String> {
    let s: Vec<char> = sddl.trim().chars().collect();
    let at = |i: usize| s.get(i).copied();
    // /^O:([^:()]+?)(?=[GDS]:|$)/
    let mut owner = None;
    if at(0) == Some('O') && at(1) == Some(':') {
        let mut e = 2;
        while e < s.len() && !matches!(s[e], ':' | '(' | ')') {
            e += 1;
            if e == s.len() || (matches!(s[e], 'G' | 'D' | 'S') && at(e + 1) == Some(':')) {
                owner = Some(s[2..e].iter().collect::<String>());
                break;
            }
        }
    }
    // The first top-level `D:` (outside any ACE).
    let mut depth: i32 = 0;
    let mut d = None;
    let mut quoted = false;
    for (i, &c) in s.iter().enumerate() {
        if c == '"' {
            quoted = !quoted;
        } else if quoted {
            continue;
        } else if c == '(' {
            depth += 1;
        } else if c == ')' {
            depth -= 1;
        } else if depth == 0 && c == 'D' && at(i + 1) == Some(':') {
            d = Some(i);
        }
        if depth < 0 {
            return Err("SDDL has unbalanced parentheses".into());
        }
        if d.is_some() {
            break;
        }
    }
    let d = d.ok_or("SDDL has no DACL")?;
    let mut i = d + 2;
    let mut dacl_flags = String::new();
    while i < s.len()
        && s[i] != '('
        && !(at(i + 1) == Some(':') && matches!(s[i], 'O' | 'G' | 'D' | 'S'))
    {
        dacl_flags.push(s[i]);
        i += 1;
    }
    let mut aces = Vec::new();
    while at(i) == Some('(') {
        // Balanced parentheses, ignoring any inside a conditional expression's "string literals".
        let mut level = 0;
        let mut quoted = false;
        let mut j = i;
        while j < s.len() {
            match s[j] {
                '"' => quoted = !quoted,
                _ if quoted => {}
                '(' => level += 1,
                ')' => {
                    level -= 1;
                    if level == 0 {
                        break;
                    }
                }
                _ => {}
            }
            j += 1;
        }
        if j >= s.len() {
            return Err("SDDL has an unterminated ACE".into());
        }
        let body: String = s[i + 1..j].iter().collect();
        let mut rest = body.as_str();
        let mut fields = Vec::new();
        for _ in 0..5 {
            let k = rest.find(';').ok_or("SDDL ACE has too few fields")?;
            fields.push(&rest[..k]);
            rest = &rest[k + 1..];
        }
        let sid = rest.split(';').next().unwrap_or("");
        let ace_type = fields[0];
        if ace_type.is_empty() || sid.is_empty() {
            return Err("SDDL ACE has an empty type or trustee".into());
        }
        aces.push(SddlAce {
            ace_type: ace_type.to_uppercase(),
            flags: fields[1].to_uppercase(),
            sid: sid.to_string(),
        });
        i = j + 1;
    }
    let tail: String = s[i.min(s.len())..].iter().collect();
    if !tail.is_empty() && !tail.starts_with("S:") {
        return Err("SDDL has unexpected data after the DACL".into());
    }
    Ok(ParsedSddl {
        owner,
        null_dacl: dacl_flags.contains("NO_ACCESS_CONTROL"),
        dacl_flags,
        aces,
    })
}

/// Fixed SDDL SID aliases (MS-DTYP 2.4.2.4).
const SDDL_ALIASES: &[(&str, &str)] = &[
    ("AA", "S-1-5-32-579"),
    ("AC", "S-1-15-2-1"),
    ("AN", "S-1-5-7"),
    ("AO", "S-1-5-32-548"),
    ("AU", "S-1-5-11"),
    ("BA", "S-1-5-32-544"),
    ("BG", "S-1-5-32-546"),
    ("BO", "S-1-5-32-551"),
    ("BU", "S-1-5-32-545"),
    ("CD", "S-1-5-32-574"),
    ("CG", "S-1-3-1"),
    ("CO", "S-1-3-0"),
    ("CY", "S-1-5-32-569"),
    ("ED", "S-1-5-9"),
    ("ER", "S-1-5-32-573"),
    ("HA", "S-1-5-32-578"),
    ("IS", "S-1-5-32-568"),
    ("IU", "S-1-5-4"),
    ("LS", "S-1-5-19"),
    ("LU", "S-1-5-32-559"),
    ("MU", "S-1-5-32-558"),
    ("NO", "S-1-5-32-556"),
    ("NS", "S-1-5-20"),
    ("NU", "S-1-5-2"),
    ("OW", "S-1-3-4"),
    ("PO", "S-1-5-32-550"),
    ("PS", "S-1-5-10"),
    ("PU", "S-1-5-32-547"),
    ("RA", "S-1-5-32-575"),
    ("RC", "S-1-5-12"),
    ("RD", "S-1-5-32-555"),
    ("RE", "S-1-5-32-552"),
    ("RM", "S-1-5-32-580"),
    ("RU", "S-1-5-32-554"),
    ("SO", "S-1-5-32-549"),
    ("SS", "S-1-18-2"),
    ("SU", "S-1-5-6"),
    ("SY", "S-1-5-18"),
    ("WD", "S-1-1-0"),
    ("WR", "S-1-5-33"),
];

/// Domain-relative SDDL aliases: the RID, appended to the domain part of the user's SID.
const SDDL_DOMAIN_RIDS: &[(&str, u32)] = &[
    ("RO", 498),
    ("LA", 500),
    ("LG", 501),
    ("DA", 512),
    ("DU", 513),
    ("DG", 514),
    ("DC", 515),
    ("DD", 516),
    ("CA", 517),
    ("SA", 518),
    ("EA", 519),
    ("PA", 520),
    ("CN", 522),
    ("AP", 525),
    ("KA", 526),
    ("EK", 527),
    ("RS", 553),
];

/// An SDDL trustee as an upper-case SID. Errs on an alias it doesn't know. A domain-relative alias
/// resolved against the wrong domain only makes the cross-check disagree (fail closed).
pub fn resolve_sddl_sid(trustee: &str, user_sid: &str) -> Result<String, String> {
    if is_sid(trustee) {
        return Ok(trustee.to_uppercase());
    }
    let key = trustee.to_uppercase();
    if let Some((_, sid)) = SDDL_ALIASES.iter().find(|(a, _)| *a == key) {
        return Ok(sid.to_string());
    }
    if let Some((_, rid)) = SDDL_DOMAIN_RIDS.iter().find(|(a, _)| *a == key) {
        let user = user_sid.to_uppercase();
        let domain = user.rsplit_once('-').map_or(user.as_str(), |(d, _)| d);
        return Ok(format!("{domain}-{rid}"));
    }
    Err(format!("SDDL names an unknown trustee alias {trustee}"))
}

fn same_sid(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

/// The fix printed in refusal messages (a command for the user to run; the daemon never does).
fn icacls_fix_hint(path: &str, user_sid: &str) -> String {
    format!(
        "icacls \"{path}\" /inheritance:r /grant:r *{user_sid}:F *{SID_SYSTEM}:F *{SID_ADMINISTRATORS}:F"
    )
}

/// Decide whether a Windows ACL is owner-only for `user_sid`. The refusal, or None if it passes.
/// Deny ACEs never widen access, so only allow-ACEs are checked. Any ACE that is not a plain
/// allow/deny (conditional XA/XD, callback, object OA/OD, ZA, ...) is refused, as is a NULL DACL,
/// and any disagreement between the SDDL, the raw ACE count and the plain ACEs.
pub fn evaluate_win_acl(
    acl: &WinAcl,
    path: &str,
    user_sid: &str,
    check_access: bool,
) -> Option<AclError> {
    let unreadable = |why: &str| {
        AclError::new(
            AclRefusal::Unreadable,
            format!("cannot verify the permissions of {path} ({why}); refusing to use it"),
        )
    };
    let sddl = match parse_sddl(&acl.sddl) {
        Ok(s) => s,
        Err(e) => return Some(unreadable(&e)),
    };
    let sddl_owner = match sddl.owner.as_deref().map(|o| resolve_sddl_sid(o, user_sid)) {
        None => None,
        Some(Ok(o)) => Some(o),
        Some(Err(e)) => return Some(unreadable(&e)),
    };
    if !sddl_owner.is_some_and(|o| same_sid(&o, &acl.owner)) {
        return Some(unreadable("the SDDL owner disagrees with Get-Acl"));
    }
    if !same_sid(&acl.owner, user_sid) {
        return Some(AclError {
            reason: AclRefusal::ForeignOwner,
            message: format!(
                "{path} is owned by another user ({}); refusing to use it",
                acl.owner
            ),
            owner: Some(acl.owner.to_uppercase()),
        });
    }
    if !check_access {
        return None;
    }
    let hint = icacls_fix_hint(path, user_sid);
    if sddl.null_dacl || acl.ace_count < 0 {
        return Some(AclError::new(
            AclRefusal::TooOpen,
            format!("{path} has no access control list (everyone has full access); run: {hint}"),
        ));
    }
    let mut odd: Vec<&str> = Vec::new();
    for a in &sddl.aces {
        if a.ace_type != "A" && a.ace_type != "D" && !odd.contains(&a.ace_type.as_str()) {
            odd.push(&a.ace_type);
        }
    }
    if !odd.is_empty() {
        return Some(AclError::new(
            AclRefusal::TooOpen,
            format!(
                "{path} has access rules that can't be verified ({}: conditional, callback or object ACEs); run: {hint}",
                odd.join(", ")
            ),
        ));
    }
    if acl.ace_count != acl.rules.len() as i64 || acl.ace_count != sddl.aces.len() as i64 {
        return Some(unreadable(&format!(
            "{} ACEs in the DACL, {} in the SDDL, {} rules",
            acl.ace_count,
            sddl.aces.len(),
            acl.rules.len()
        )));
    }
    let mut sddl_keys = Vec::new();
    for a in &sddl.aces {
        match resolve_sddl_sid(&a.sid, user_sid) {
            Ok(sid) => sddl_keys.push(format!("{}:{sid}", a.ace_type)),
            Err(e) => return Some(unreadable(&e)),
        }
    }
    let rule_keys: Vec<String> = acl
        .rules
        .iter()
        .map(|r| {
            format!(
                "{}:{}",
                if r.allow { "A" } else { "D" },
                r.sid.to_uppercase()
            )
        })
        .collect();
    let same_set = sddl_keys.iter().all(|k| rule_keys.contains(k))
        && rule_keys.iter().all(|k| sddl_keys.contains(k));
    if !same_set {
        return Some(unreadable("the SDDL disagrees with Get-Acl"));
    }
    if sddl.dacl_flags.contains('P') != acl.protected {
        return Some(unreadable(
            "the SDDL protection flag disagrees with Get-Acl",
        ));
    }
    if !acl.protected
        || acl.rules.iter().any(|r| r.inherited)
        || sddl.aces.iter().any(|a| a.flags.contains("ID"))
    {
        return Some(AclError::new(
            AclRefusal::Inherited,
            format!("{path} inherits permissions from its parent folder; run: {hint}"),
        ));
    }
    let allowed = [user_sid, SID_SYSTEM, SID_ADMINISTRATORS];
    let mut others: Vec<String> = Vec::new();
    for r in acl.rules.iter().filter(|r| r.allow) {
        let sid = r.sid.to_uppercase();
        if !allowed.iter().any(|a| same_sid(a, &sid)) && !others.contains(&sid) {
            others.push(sid);
        }
    }
    if !others.is_empty() {
        return Some(AclError::new(
            AclRefusal::TooOpen,
            format!(
                "{path} is accessible to other users ({}); run: {hint}",
                others.join(", ")
            ),
        ));
    }
    None
}

/// Inheritance flags of an owner-only ACE: none for a file; object + container inherit for a dir,
/// so its new children start owner-only too.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AceInherit {
    pub object: bool,
    pub container: bool,
}

/// The owner-only DACL (what `icaclsRestrictArgs` granted): full control for the user, SYSTEM and
/// Administrators and nobody else, in that order; inheritance from the parent removed. Pure.
pub fn owner_only_aces(user_sid: &str, kind: AclKind) -> Vec<(String, AceInherit)> {
    let inherit = AceInherit {
        object: kind == AclKind::Dir,
        container: kind == AclKind::Dir,
    };
    [user_sid, SID_SYSTEM, SID_ADMINISTRATORS]
        .iter()
        .map(|s| (s.to_uppercase(), inherit))
        .collect()
}

// ---------------------------------------------------------------------------------------------
// POSIX (copied from credential.ts; messages unchanged)

#[cfg(unix)]
mod imp {
    use super::{
        AclError, AclKind, AclRefusal, AssertOwnerOnlyOptions, PrivateError, WinAcl, assert_type,
    };
    use std::fs::{self, OpenOptions, Permissions};
    use std::io::Write;
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
    use std::path::Path;

    pub fn current_user_sid() -> Result<String, AclError> {
        Err(AclError::new(
            AclRefusal::Unreadable,
            "currentUserSid is only available on win32",
        ))
    }

    pub fn read_win_acl(path: &Path) -> Result<WinAcl, AclError> {
        Err(AclError::new(
            AclRefusal::Unreadable,
            format!(
                "cannot read the permissions of {} (not win32)",
                path.display()
            ),
        ))
    }

    pub fn write_private_file(path: &Path, tmp: &Path, data: &[u8]) -> Result<(), PrivateError> {
        // As config.ts writeFileConfig: create 0600 exclusively, chmod (umask-proof), rename.
        let mut f = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(tmp)?;
        let r = f
            .write_all(data)
            .and_then(|()| f.sync_all())
            .and_then(|()| fs::set_permissions(tmp, Permissions::from_mode(0o600)))
            .and_then(|()| fs::rename(tmp, path));
        drop(f);
        if let Err(e) = r {
            let _ = fs::remove_file(tmp);
            return Err(e.into());
        }
        Ok(())
    }

    pub fn mkdir_private(path: &Path) -> Result<(), PrivateError> {
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(path)?;
        // Type and owner first: chmod follows symlinks, and a foreign dir must not be touched.
        assert_owner_only(
            path,
            AssertOwnerOnlyOptions {
                kind: AclKind::Dir,
                check_access: false,
            },
        )?;
        fs::set_permissions(path, Permissions::from_mode(0o700))?;
        Ok(())
    }

    pub fn assert_owner_only(
        path: &Path,
        opts: AssertOwnerOnlyOptions,
    ) -> Result<(), PrivateError> {
        assert_posix_as(path, opts, nix::unistd::getuid().as_raw())
    }

    /// `assert_owner_only` with the uid to compare against (tests pass another one).
    pub fn assert_posix_as(
        path: &Path,
        opts: AssertOwnerOnlyOptions,
        uid: u32,
    ) -> Result<(), PrivateError> {
        let st = fs::symlink_metadata(path)?;
        assert_type(path, &st, opts.kind)?;
        let p = path.display();
        if st.uid() != uid {
            return Err(AclError::new(
                AclRefusal::ForeignOwner,
                format!("{p} is owned by another user; refusing to use it"),
            )
            .into());
        }
        if opts.kind == AclKind::File && opts.check_access && st.mode() & 0o077 != 0 {
            return Err(AclError::new(
                AclRefusal::TooOpen,
                format!("{p} is readable by other users; run: chmod 600 {p}"),
            )
            .into());
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------------------------
// Windows

#[cfg(windows)]
mod imp {
    use super::{
        AclError, AclKind, AclRefusal, AssertOwnerOnlyOptions, PrivateError, SID_ADMINISTRATORS,
        WinAcl, WinRule, assert_type, evaluate_win_acl, owner_only_aces,
    };
    use std::ffi::OsStr;
    use std::fs::File;
    use std::io::{self, Write};
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::FromRawHandle;
    use std::path::{Path, PathBuf};
    use std::sync::OnceLock;
    use windows_sys::Win32::Foundation::{
        CloseHandle, ERROR_ALREADY_EXISTS, GENERIC_READ, GENERIC_WRITE, HANDLE,
        INVALID_HANDLE_VALUE, LocalFree,
    };
    use windows_sys::Win32::Security::Authorization::{
        ConvertSecurityDescriptorToStringSecurityDescriptorW, ConvertSidToStringSidW,
        ConvertStringSidToSidW, GetSecurityInfo, SDDL_REVISION_1, SE_FILE_OBJECT, SetSecurityInfo,
    };
    use windows_sys::Win32::Security::{
        ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, ACL_REVISION, AddAccessAllowedAceEx,
        CONTAINER_INHERIT_ACE, DACL_SECURITY_INFORMATION, GetAce, GetLengthSid,
        GetSecurityDescriptorControl, GetTokenInformation, INHERITED_ACE, InitializeAcl,
        InitializeSecurityDescriptor, OBJECT_INHERIT_ACE, OWNER_SECURITY_INFORMATION,
        PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, SE_DACL_PROTECTED,
        SECURITY_ATTRIBUTES, SECURITY_DESCRIPTOR, SetSecurityDescriptorControl,
        SetSecurityDescriptorDacl, SetSecurityDescriptorOwner, TOKEN_QUERY, TOKEN_USER, TokenUser,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, CREATE_NEW, CreateDirectoryW, CreateFileW, DELETE,
        FILE_ALL_ACCESS, FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_REPARSE_POINT,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES,
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, GetFileInformationByHandle,
        OPEN_EXISTING, READ_CONTROL, WRITE_DAC, WRITE_OWNER,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    // Win32_System_SystemServices is not a feature we pull in for three constants.
    const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
    const ACCESS_DENIED_ACE_TYPE: u8 = 1;
    const SECURITY_DESCRIPTOR_REVISION: u32 = 1;

    fn wide(p: &OsStr) -> Vec<u16> {
        p.encode_wide().chain(Some(0)).collect()
    }

    fn from_wide_ptr(p: *const u16) -> String {
        // SAFETY: `p` is a NUL-terminated UTF-16 string from the OS.
        unsafe {
            let mut len = 0;
            while *p.add(len) != 0 {
                len += 1;
            }
            String::from_utf16_lossy(std::slice::from_raw_parts(p, len))
        }
    }

    /// LocalFree on drop (strings and descriptors the OS allocated for us).
    struct Local(*mut core::ffi::c_void);
    impl Drop for Local {
        fn drop(&mut self) {
            if !self.0.is_null() {
                // SAFETY: allocated by the OS with LocalAlloc.
                unsafe { LocalFree(self.0) };
            }
        }
    }

    struct Handle(HANDLE);
    impl Drop for Handle {
        fn drop(&mut self) {
            // SAFETY: our handle, closed once.
            unsafe { CloseHandle(self.0) };
        }
    }

    fn sid_string(sid: PSID) -> io::Result<String> {
        let mut s: *mut u16 = std::ptr::null_mut();
        // SAFETY: a valid SID; the string is LocalFree'd.
        if unsafe { ConvertSidToStringSidW(sid, &mut s) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let _free = Local(s.cast());
        Ok(from_wide_ptr(s).to_uppercase())
    }

    /// A SID parsed from its string form, freed on drop.
    struct Sid(Local);
    impl Sid {
        fn parse(s: &str) -> io::Result<Sid> {
            let w = wide(OsStr::new(s));
            let mut p: PSID = std::ptr::null_mut();
            // SAFETY: a NUL-terminated string; the SID is LocalFree'd by `Local`.
            if unsafe { ConvertStringSidToSidW(w.as_ptr(), &mut p) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(Sid(Local(p)))
        }
        fn ptr(&self) -> PSID {
            self.0.0
        }
    }

    static SID: OnceLock<String> = OnceLock::new();

    fn token_user_sid() -> io::Result<String> {
        // SAFETY: plain Win32 calls; the token handle is closed by `Handle`.
        unsafe {
            let mut token: HANDLE = std::ptr::null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                return Err(io::Error::last_os_error());
            }
            let token = Handle(token);
            let mut len = 0u32;
            GetTokenInformation(token.0, TokenUser, std::ptr::null_mut(), 0, &mut len);
            let mut buf = vec![0u64; (len as usize).div_ceil(8)];
            if GetTokenInformation(token.0, TokenUser, buf.as_mut_ptr().cast(), len, &mut len) == 0
            {
                return Err(io::Error::last_os_error());
            }
            let user = &*(buf.as_ptr() as *const TOKEN_USER);
            sid_string(user.User.Sid)
        }
    }

    pub fn current_user_sid() -> Result<String, AclError> {
        if let Some(s) = SID.get() {
            return Ok(s.clone());
        }
        let sid = token_user_sid().map_err(|e| {
            AclError::new(
                AclRefusal::Unreadable,
                format!("cannot determine the current user's SID: {e}"),
            )
        })?;
        Ok(SID.get_or_init(|| sid).clone())
    }

    /// The path itself, never what it points to; refused when it is a reparse point.
    fn open_no_follow(path: &Path, access: u32) -> io::Result<Handle> {
        let w = wide(path.as_os_str());
        // SAFETY: a NUL-terminated path; the handle is owned by `Handle`.
        unsafe {
            let h = CreateFileW(
                w.as_ptr(),
                access | FILE_READ_ATTRIBUTES,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                std::ptr::null_mut(),
            );
            if h == INVALID_HANDLE_VALUE {
                return Err(io::Error::last_os_error());
            }
            let h = Handle(h);
            let mut info: BY_HANDLE_FILE_INFORMATION = std::mem::zeroed();
            if GetFileInformationByHandle(h.0, &mut info) == 0 {
                return Err(io::Error::last_os_error());
            }
            if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                return Err(io::Error::other("a reparse point (link or junction)"));
            }
            Ok(h)
        }
    }

    fn read_acl_handle(h: HANDLE) -> io::Result<WinAcl> {
        // SAFETY: plain Win32 calls on a live handle; the descriptor and string are LocalFree'd,
        // and every pointer into the descriptor is used before that.
        unsafe {
            let mut owner: PSID = std::ptr::null_mut();
            let mut dacl: *mut ACL = std::ptr::null_mut();
            let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
            let rc = GetSecurityInfo(
                h,
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                &mut owner,
                std::ptr::null_mut(),
                &mut dacl,
                std::ptr::null_mut(),
                &mut sd,
            );
            if rc != 0 {
                return Err(io::Error::from_raw_os_error(rc as i32));
            }
            let _sd = Local(sd);
            if owner.is_null() {
                return Err(io::Error::other("no owner"));
            }
            let owner = sid_string(owner)?;
            let mut control = 0u16;
            let mut rev = 0u32;
            if GetSecurityDescriptorControl(sd, &mut control, &mut rev) == 0 {
                return Err(io::Error::last_os_error());
            }
            let mut rules = Vec::new();
            let ace_count = if dacl.is_null() {
                -1
            } else {
                let count = (*dacl).AceCount;
                for i in 0..u32::from(count) {
                    let mut ace: *mut core::ffi::c_void = std::ptr::null_mut();
                    if GetAce(dacl, i, &mut ace) == 0 {
                        return Err(io::Error::last_os_error());
                    }
                    let header = &*(ace as *const ACE_HEADER);
                    // Like GetAccessRules: only the plain allow/deny ACEs become rules; the SDDL and
                    // the count expose the rest.
                    if header.AceType == ACCESS_ALLOWED_ACE_TYPE
                        || header.AceType == ACCESS_DENIED_ACE_TYPE
                    {
                        let a = ace as *const ACCESS_ALLOWED_ACE;
                        let sid = std::ptr::addr_of!((*a).SidStart) as PSID;
                        rules.push(WinRule {
                            sid: sid_string(sid)?,
                            allow: header.AceType == ACCESS_ALLOWED_ACE_TYPE,
                            inherited: u32::from(header.AceFlags) & INHERITED_ACE != 0,
                        });
                    }
                }
                i64::from(count)
            };
            let mut s: *mut u16 = std::ptr::null_mut();
            if ConvertSecurityDescriptorToStringSecurityDescriptorW(
                sd,
                SDDL_REVISION_1,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                &mut s,
                std::ptr::null_mut(),
            ) == 0
            {
                return Err(io::Error::last_os_error());
            }
            let _s = Local(s.cast());
            Ok(WinAcl {
                owner,
                protected: control & SE_DACL_PROTECTED != 0,
                rules,
                sddl: from_wide_ptr(s),
                ace_count,
            })
        }
    }

    pub fn read_win_acl(path: &Path) -> Result<WinAcl, AclError> {
        open_no_follow(path, READ_CONTROL)
            .and_then(|h| read_acl_handle(h.0))
            .map_err(|e| {
                AclError::new(
                    AclRefusal::Unreadable,
                    format!(
                        "cannot read the permissions of {} ({e}); refusing to use it",
                        path.display()
                    ),
                )
            })
    }

    /// The owner-only DACL for `kind`, with the SIDs it points at (kept alive alongside).
    struct OwnerOnly {
        acl: Vec<u64>,
        sids: Vec<Sid>,
    }

    impl OwnerOnly {
        fn build(user_sid: &str, kind: AclKind) -> io::Result<OwnerOnly> {
            let aces = owner_only_aces(user_sid, kind);
            let sids = aces
                .iter()
                .map(|(s, _)| Sid::parse(s))
                .collect::<io::Result<Vec<_>>>()?;
            // SAFETY: valid SIDs; the ACL buffer is sized for every ACE and u64-aligned.
            unsafe {
                let mut size = std::mem::size_of::<ACL>();
                for s in &sids {
                    size += std::mem::size_of::<ACCESS_ALLOWED_ACE>() - std::mem::size_of::<u32>()
                        + GetLengthSid(s.ptr()) as usize;
                }
                let size = size.next_multiple_of(4);
                let mut acl = vec![0u64; size.div_ceil(8)];
                let p = acl.as_mut_ptr() as *mut ACL;
                if InitializeAcl(p, size as u32, ACL_REVISION) == 0 {
                    return Err(io::Error::last_os_error());
                }
                for (s, (_, inherit)) in sids.iter().zip(&aces) {
                    let mut flags = 0;
                    if inherit.object {
                        flags |= OBJECT_INHERIT_ACE;
                    }
                    if inherit.container {
                        flags |= CONTAINER_INHERIT_ACE;
                    }
                    if AddAccessAllowedAceEx(p, ACL_REVISION, flags, FILE_ALL_ACCESS, s.ptr()) == 0
                    {
                        return Err(io::Error::last_os_error());
                    }
                }
                Ok(OwnerOnly { acl, sids })
            }
        }

        fn acl(&self) -> *const ACL {
            self.acl.as_ptr() as *const ACL
        }

        fn user(&self) -> PSID {
            self.sids[0].ptr()
        }
    }

    /// A security descriptor (owner = the user, the protected owner-only DACL) for creating.
    struct OwnerOnlySd {
        _dacl: OwnerOnly,
        sd: Box<SECURITY_DESCRIPTOR>,
    }

    impl OwnerOnlySd {
        fn build(user_sid: &str, kind: AclKind) -> io::Result<OwnerOnlySd> {
            let dacl = OwnerOnly::build(user_sid, kind)?;
            // SAFETY: the descriptor and everything it points at live as long as `OwnerOnlySd`.
            unsafe {
                let mut sd: Box<SECURITY_DESCRIPTOR> = Box::new(std::mem::zeroed());
                let p = (&mut *sd as *mut SECURITY_DESCRIPTOR).cast();
                if InitializeSecurityDescriptor(p, SECURITY_DESCRIPTOR_REVISION) == 0
                    || SetSecurityDescriptorOwner(p, dacl.user(), 0) == 0
                    || SetSecurityDescriptorDacl(p, 1, dacl.acl(), 0) == 0
                    || SetSecurityDescriptorControl(p, SE_DACL_PROTECTED, SE_DACL_PROTECTED) == 0
                {
                    return Err(io::Error::last_os_error());
                }
                Ok(OwnerOnlySd { _dacl: dacl, sd })
            }
        }

        fn attributes(&mut self) -> SECURITY_ATTRIBUTES {
            SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: (&mut *self.sd as *mut SECURITY_DESCRIPTOR).cast(),
                bInheritHandle: 0,
            }
        }
    }

    /// Make an existing `path` owner-only: the user as owner, the protected owner-only DACL.
    fn restrict(path: &Path, kind: AclKind) -> Result<(), AclError> {
        let fail = |e: io::Error| {
            AclError::new(
                AclRefusal::Unreadable,
                format!("cannot restrict the permissions of {}: {e}", path.display()),
            )
        };
        let sid = current_user_sid()?;
        let dacl = OwnerOnly::build(&sid, kind).map_err(fail)?;
        let h = open_no_follow(path, READ_CONTROL | WRITE_DAC | WRITE_OWNER).map_err(fail)?;
        // SAFETY: a live handle, and an owner SID and DACL that outlive the call.
        let rc = unsafe {
            SetSecurityInfo(
                h.0,
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION
                    | DACL_SECURITY_INFORMATION
                    | PROTECTED_DACL_SECURITY_INFORMATION,
                dacl.user(),
                std::ptr::null_mut(),
                dacl.acl(),
                std::ptr::null(),
            )
        };
        if rc != 0 {
            return Err(fail(io::Error::from_raw_os_error(rc as i32)));
        }
        Ok(())
    }

    fn assert_win32(path: &Path, opts: AssertOwnerOnlyOptions) -> Result<(), PrivateError> {
        let meta = std::fs::symlink_metadata(path)?;
        assert_type(path, &meta, opts.kind)?;
        let user = current_user_sid()?;
        let acl = read_win_acl(path)?;
        match evaluate_win_acl(&acl, &path.display().to_string(), &user, opts.check_access) {
            Some(refusal) => Err(refusal.into()),
            None => Ok(()),
        }
    }

    pub fn assert_owner_only(
        path: &Path,
        opts: AssertOwnerOnlyOptions,
    ) -> Result<(), PrivateError> {
        assert_win32(path, opts)
    }

    fn dir_opts() -> AssertOwnerOnlyOptions {
        AssertOwnerOnlyOptions::new(AclKind::Dir)
    }

    fn reword(e: PrivateError, f: impl FnOnce(&AclError) -> String) -> PrivateError {
        match e {
            PrivateError::Acl(a) => PrivateError::Acl(AclError {
                message: f(&a),
                ..a
            }),
            other => other,
        }
    }

    pub fn write_private_file(path: &Path, tmp: &Path, data: &[u8]) -> Result<(), PrivateError> {
        // The folder must already be private (TS parity; the new file carries its own owner-only
        // descriptor from the start, so nothing inherits in between either way).
        let abs = std::path::absolute(path)?;
        let dir = abs.parent().unwrap_or(&abs).to_path_buf();
        assert_win32(&dir, dir_opts()).map_err(|e| {
            reword(e, |a| {
                format!(
                    "refusing to write {}: its folder is not private ({})",
                    path.display(),
                    a.message
                )
            })
        })?;
        let user = current_user_sid()?;
        let mut sd = OwnerOnlySd::build(&user, AclKind::File)?;
        let sa = sd.attributes();
        let w = wide(tmp.as_os_str());
        // SAFETY: a NUL-terminated path and attributes that outlive the call; the handle is owned
        // by the File.
        let file = unsafe {
            let h = CreateFileW(
                w.as_ptr(),
                GENERIC_READ | GENERIC_WRITE | DELETE,
                0,
                &sa,
                CREATE_NEW,
                FILE_ATTRIBUTE_NORMAL,
                std::ptr::null_mut(),
            );
            if h == INVALID_HANDLE_VALUE {
                return Err(io::Error::last_os_error().into());
            }
            File::from_raw_handle(h)
        };
        let r = (|| -> Result<(), PrivateError> {
            assert_win32(tmp, AssertOwnerOnlyOptions::new(AclKind::File))?;
            let mut file = file;
            file.write_all(data)?;
            file.sync_all()?;
            drop(file);
            std::fs::rename(tmp, path)?;
            Ok(())
        })();
        if r.is_err() {
            let _ = std::fs::remove_file(tmp);
        }
        r
    }

    /// The user's profile dir or %LOCALAPPDATA% (per-user by default).
    #[allow(deprecated)] // std::env::home_dir: deprecated on older toolchains, fixed on Windows since 1.85
    fn is_per_user_base(dir: &Path) -> bool {
        let canon = |p: &Path| {
            std::fs::canonicalize(p)
                .ok()
                .map(|c| c.to_string_lossy().to_lowercase())
        };
        let Some(target) = canon(dir) else {
            return false;
        };
        [
            std::env::home_dir(),
            std::env::var_os("LOCALAPPDATA").map(PathBuf::from),
        ]
        .into_iter()
        .flatten()
        .filter(|p| !p.as_os_str().is_empty())
        .any(|p| canon(&p).as_deref() == Some(target.as_str()))
    }

    fn lstat_or_none(p: &Path) -> io::Result<Option<std::fs::Metadata>> {
        match std::fs::symlink_metadata(p) {
            Ok(m) => Ok(Some(m)),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// Type and owner first, as on POSIX. An elevated admin's new dirs are owned by Administrators
    /// (the token's default owner), so that owner is accepted here only: Administrators already
    /// holds full control in the final DACL, `restrict` makes the user the owner, and the final
    /// check requires exactly that.
    fn make_dir_private(dir: &Path, created: bool) -> Result<(), PrivateError> {
        let meta = std::fs::symlink_metadata(dir)?;
        assert_type(dir, &meta, AclKind::Dir)?;
        if !created {
            let user = current_user_sid()?;
            let pre = evaluate_win_acl(
                &read_win_acl(dir)?,
                &dir.display().to_string(),
                &user,
                false,
            );
            if let Some(pre) = pre {
                let admin_owner = pre.reason == AclRefusal::ForeignOwner
                    && pre.owner.as_deref() == Some(SID_ADMINISTRATORS);
                if !admin_owner {
                    return Err(pre.into());
                }
            }
        }
        restrict(dir, AclKind::Dir)?;
        assert_win32(dir, dir_opts())
    }

    pub fn mkdir_private(path: &Path) -> Result<(), PrivateError> {
        // The levels to create, outermost first, and the nearest existing ancestor.
        let abs = std::path::absolute(path)?;
        let mut missing: Vec<PathBuf> = Vec::new();
        let mut ancestor = abs.clone();
        while lstat_or_none(&ancestor)?.is_none() {
            missing.insert(0, ancestor.clone());
            match ancestor.parent() {
                Some(up) if up != ancestor => ancestor = up.to_path_buf(),
                _ => break,
            }
        }
        if !missing.is_empty() && !is_per_user_base(&ancestor) {
            assert_win32(&ancestor, dir_opts()).map_err(|e| {
                reword(e, |a| {
                    format!(
                        "refusing to create {}: {} is not private ({})",
                        path.display(),
                        ancestor.display(),
                        a.message
                    )
                })
            })?;
        }
        let user = current_user_sid()?;
        for dir in &missing {
            let mut sd = OwnerOnlySd::build(&user, AclKind::Dir)?;
            let sa = sd.attributes();
            let w = wide(dir.as_os_str());
            // SAFETY: a NUL-terminated path and attributes that outlive the call.
            let ok = unsafe { CreateDirectoryW(w.as_ptr(), &sa) } != 0;
            let created = if ok {
                true
            } else {
                let e = io::Error::last_os_error();
                // Created concurrently: the owner check decides whether it is ours.
                if e.raw_os_error() != Some(ERROR_ALREADY_EXISTS as i32) {
                    return Err(e.into());
                }
                false
            };
            make_dir_private(dir, created)?;
        }
        if missing.is_empty() {
            make_dir_private(&abs, false)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const USER: &str = "S-1-5-21-1004336348-1177238915-682003330-1001";
    const EVERYONE: &str = "S-1-1-0";
    const USERS: &str = "S-1-5-32-545";
    const PATH: &str = "C:\\Users\\ben\\.conductor\\machine.json";

    fn rule(sid: &str, allow: bool, inherited: bool) -> WinRule {
        WinRule {
            sid: sid.to_string(),
            allow,
            inherited,
        }
    }

    /// A WinAcl with its SDDL and raw ACE count derived from the rules (what Windows has for a
    /// DACL with only plain ACEs).
    fn mk(owner: &str, protected: bool, rules: Vec<WinRule>) -> WinAcl {
        let aces: String = rules
            .iter()
            .map(|r| {
                format!(
                    "({};{};FA;;;{})",
                    if r.allow { "A" } else { "D" },
                    if r.inherited { "ID" } else { "" },
                    r.sid
                )
            })
            .collect();
        WinAcl {
            owner: owner.to_string(),
            protected,
            sddl: format!("O:{owner}D:{}{aces}", if protected { "PAI" } else { "AI" }),
            ace_count: rules.len() as i64,
            rules,
        }
    }

    fn owner_only_rules() -> Vec<WinRule> {
        vec![
            rule(USER, true, false),
            rule(SID_SYSTEM, true, false),
            rule(SID_ADMINISTRATORS, true, false),
        ]
    }

    fn owner_only() -> WinAcl {
        mk(USER, true, owner_only_rules())
    }

    // What Windows prints for an owner-only DACL: aliases for SYSTEM and Administrators.
    fn real_sddl() -> String {
        format!("O:{USER}D:PAI(A;;FA;;;{USER})(A;;FA;;;SY)(A;;FA;;;BA)")
    }

    fn eval(acl: &WinAcl) -> Option<AclError> {
        evaluate_win_acl(acl, PATH, USER, true)
    }

    fn reason(acl: &WinAcl) -> Option<AclRefusal> {
        eval(acl).map(|e| e.reason)
    }

    // ------------------------------------------------------------ parse_sddl / resolve_sddl_sid

    #[test]
    fn parse_sddl_reads_owner_flags_and_aces_skipping_conditional_expressions() {
        let p = parse_sddl(&format!(
            "O:{USER}G:DUD:PAI(A;OICI;FA;;;{USER})(XA;;FX;;;WD;(Member_of {{SID(BA)}} && (@User.x == \"a;b)\")))(A;ID;FA;;;SY)S:AI"
        ))
        .unwrap();
        assert_eq!(p.owner.as_deref(), Some(USER));
        assert_eq!(p.dacl_flags, "PAI");
        assert!(!p.null_dacl);
        let ace = |t: &str, f: &str, s: &str| SddlAce {
            ace_type: t.into(),
            flags: f.into(),
            sid: s.into(),
        };
        assert_eq!(
            p.aces,
            vec![
                ace("A", "OICI", USER),
                ace("XA", "", "WD"),
                ace("A", "ID", "SY")
            ]
        );
    }

    #[test]
    fn parse_sddl_finds_the_dacl_after_alias_owners_and_groups_containing_a_d() {
        let p = parse_sddl("O:DDG:DDD:P(A;;FA;;;DD)").unwrap();
        assert_eq!(p.owner.as_deref(), Some("DD"));
        assert_eq!(p.dacl_flags, "P");
        assert_eq!(p.aces.len(), 1);
        assert_eq!(
            (p.aces[0].ace_type.as_str(), p.aces[0].sid.as_str()),
            ("A", "DD")
        );
        let n = parse_sddl("O:BAD:NO_ACCESS_CONTROL").unwrap();
        assert_eq!(n.owner.as_deref(), Some("BA"));
        assert!(n.null_dacl);
    }

    #[test]
    fn parse_sddl_errs_on_malformed_input() {
        for (name, sddl) in [
            ("no DACL", format!("O:{USER}")),
            ("unterminated ACE", format!("O:{USER}D:P(A;;FA;;;{USER}")),
            ("too few fields", format!("O:{USER}D:P(A;;FA;{USER})")),
            ("empty trustee", format!("O:{USER}D:P(A;;FA;;;)")),
            (
                "junk after the DACL",
                format!("O:{USER}D:P(A;;FA;;;SY)junk"),
            ),
            ("unbalanced", format!("O:{USER})D:P")),
        ] {
            assert!(parse_sddl(&sddl).is_err(), "{name}");
        }
    }

    #[test]
    fn resolve_sddl_sid_resolves_sids_and_aliases_refusing_unknown_ones() {
        assert_eq!(resolve_sddl_sid(&USER.to_lowercase(), USER).unwrap(), USER);
        assert_eq!(resolve_sddl_sid("SY", USER).unwrap(), SID_SYSTEM);
        assert_eq!(resolve_sddl_sid("ba", USER).unwrap(), SID_ADMINISTRATORS);
        assert_eq!(resolve_sddl_sid("WD", USER).unwrap(), EVERYONE);
        assert_eq!(
            resolve_sddl_sid("LA", USER).unwrap(),
            "S-1-5-21-1004336348-1177238915-682003330-500"
        );
        assert!(
            resolve_sddl_sid("QQ", USER)
                .unwrap_err()
                .contains("unknown trustee alias")
        );
    }

    // ------------------------------------------------------------ evaluate_win_acl

    #[test]
    fn evaluate_passes_an_owner_only_acl() {
        assert_eq!(eval(&owner_only()), None);
        assert_eq!(
            eval(&WinAcl {
                sddl: real_sddl(),
                ..owner_only()
            }),
            None
        );
        assert_eq!(
            eval(&mk(&USER.to_lowercase(), true, owner_only_rules())),
            None
        );
        assert_eq!(eval(&mk(USER, true, vec![])), None);
    }

    #[test]
    fn evaluate_refuses_a_foreign_owner_naming_it() {
        let r = eval(&mk(SID_ADMINISTRATORS, true, owner_only_rules())).unwrap();
        assert_eq!(r.reason, AclRefusal::ForeignOwner);
        assert_eq!(r.owner.as_deref(), Some(SID_ADMINISTRATORS));
        assert_eq!(
            r.message,
            format!("{PATH} is owned by another user ({SID_ADMINISTRATORS}); refusing to use it")
        );
        // Even when only the owner is being checked.
        let r = evaluate_win_acl(&mk(SID_SYSTEM, true, owner_only_rules()), PATH, USER, false);
        assert_eq!(r.map(|e| e.reason), Some(AclRefusal::ForeignOwner));
    }

    #[test]
    fn evaluate_refuses_an_allow_ace_for_another_sid_with_the_fix() {
        for sid in [EVERYONE, USERS, "S-1-5-11", "S-1-5-21-1-2-3-1002"] {
            let mut rules = owner_only_rules();
            rules.push(rule(sid, true, false));
            let r = eval(&mk(USER, true, rules)).unwrap();
            assert_eq!(r.reason, AclRefusal::TooOpen);
            assert!(
                r.message
                    .contains(&format!("is accessible to other users ({sid})"))
            );
            assert!(r.message.contains(&format!(
                "icacls \"{PATH}\" /inheritance:r /grant:r *{USER}:F"
            )));
        }
    }

    #[test]
    fn evaluate_ignores_deny_aces_for_other_sids() {
        let mut rules = owner_only_rules();
        rules.push(rule(EVERYONE, false, false));
        assert_eq!(eval(&mk(USER, true, rules)), None);
    }

    #[test]
    fn evaluate_refuses_inheritance_on_the_acl_a_rule_or_an_sddl_ace() {
        assert_eq!(
            reason(&mk(USER, false, owner_only_rules())),
            Some(AclRefusal::Inherited)
        );
        let mut rules = owner_only_rules();
        rules[0] = rule(USER, true, true);
        let r = eval(&mk(USER, true, rules)).unwrap();
        assert_eq!(r.reason, AclRefusal::Inherited);
        assert!(
            r.message
                .contains("inherits permissions from its parent folder")
        );
        let sddl_only = WinAcl {
            sddl: real_sddl().replace("(A;;FA;;;SY)", "(A;ID;FA;;;SY)"),
            ..owner_only()
        };
        assert_eq!(reason(&sddl_only), Some(AclRefusal::Inherited));
    }

    #[test]
    fn evaluate_check_access_false_checks_only_the_owner() {
        let acl = mk(USER, false, vec![rule(EVERYONE, true, true)]);
        assert_eq!(evaluate_win_acl(&acl, PATH, USER, false), None);
    }

    #[test]
    fn evaluate_refuses_an_ace_the_rules_do_not_show() {
        // Conditional / callback / object ACEs are not plain ACEs: the rules look owner-only.
        for (ty, ace) in [
            ("XA", "(XA;;FA;;;WD;(@User.Department == \"Eng\"))"),
            ("XD", "(XD;;FA;;;WD;(@User.x == 1))"),
            ("ZA", "(ZA;;FA;;;WD;;(@Resource.x == 1))"),
            ("OA", "(OA;;FA;bf967aba-0de6-11d0-a285-00aa003049e2;;WD)"),
            ("XU", "(XU;;FA;;;WD;(@User.x == 1))"),
        ] {
            for ace_count in [3, 4] {
                let acl = WinAcl {
                    sddl: real_sddl() + ace,
                    ace_count,
                    ..owner_only()
                };
                let r = eval(&acl).unwrap();
                assert_eq!(r.reason, AclRefusal::TooOpen, "{ty}");
                assert!(
                    r.message.contains(&format!("can't be verified ({ty}")),
                    "{}",
                    r.message
                );
            }
        }
    }

    #[test]
    fn evaluate_refuses_a_null_dacl() {
        let base = mk(USER, true, vec![]);
        let from_sddl = WinAcl {
            sddl: format!("O:{USER}D:NO_ACCESS_CONTROL"),
            ..base.clone()
        };
        assert_eq!(reason(&from_sddl), Some(AclRefusal::TooOpen));
        let from_count = WinAcl {
            ace_count: -1,
            ..base
        };
        assert_eq!(reason(&from_count), Some(AclRefusal::TooOpen));
    }

    #[test]
    fn evaluate_treats_any_disagreement_as_unreadable() {
        let base = owner_only();
        let with = |sddl: String| WinAcl {
            sddl,
            ..base.clone()
        };
        let cases = vec![
            // The raw DACL has an ACE the rules don't.
            WinAcl {
                ace_count: 4,
                ..base.clone()
            },
            // The SDDL has an Everyone allow the rules don't (same counts).
            with(real_sddl().replace("(A;;FA;;;BA)", "(A;;FA;;;WD)")),
            // Allow vs deny disagree.
            with(real_sddl().replace("(A;;FA;;;BA)", "(D;;FA;;;BA)")),
            // Owner disagrees.
            with(real_sddl().replace(&format!("O:{USER}"), "O:BA")),
            // No owner in the SDDL.
            with(real_sddl().replace(&format!("O:{USER}"), "")),
            // Protection flag disagrees.
            with(real_sddl().replace("D:PAI", "D:AI")),
            // Unknown alias.
            with(real_sddl().replace("(A;;FA;;;BA)", "(A;;FA;;;QQ)")),
            // Malformed SDDL.
            with("garbage".into()),
        ];
        for acl in cases {
            let r = eval(&acl).unwrap_or_else(|| panic!("passed: {}", acl.sddl));
            assert_eq!(r.reason, AclRefusal::Unreadable, "{}", acl.sddl);
            assert!(r.message.contains("refusing to use it"));
        }
    }

    #[test]
    fn owner_only_aces_grant_only_user_system_and_administrators_dirs_propagate() {
        let none = AceInherit {
            object: false,
            container: false,
        };
        assert_eq!(
            owner_only_aces(USER, AclKind::File),
            vec![
                (USER.to_string(), none),
                ("S-1-5-18".to_string(), none),
                ("S-1-5-32-544".to_string(), none)
            ]
        );
        let both = AceInherit {
            object: true,
            container: true,
        };
        assert!(
            owner_only_aces(USER, AclKind::Dir)
                .iter()
                .all(|(_, i)| *i == both)
        );
    }

    // ------------------------------------------------------------ real file systems

    fn refusal(r: Result<(), PrivateError>) -> AclError {
        match r {
            Err(PrivateError::Acl(a)) => a,
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    fn file_opts() -> AssertOwnerOnlyOptions {
        AssertOwnerOnlyOptions::new(AclKind::File)
    }

    fn dir_opts() -> AssertOwnerOnlyOptions {
        AssertOwnerOnlyOptions::new(AclKind::Dir)
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        v.sort();
        v
    }

    #[cfg(unix)]
    mod posix {
        use super::*;
        use std::os::unix::fs::{MetadataExt, PermissionsExt, symlink};

        fn mode(p: &Path) -> u32 {
            std::fs::metadata(p).unwrap().mode() & 0o777
        }

        fn chmod(p: &Path, m: u32) {
            std::fs::set_permissions(p, std::fs::Permissions::from_mode(m)).unwrap();
        }

        #[test]
        fn write_private_file_writes_0600_atomically_leaving_no_temp_file() {
            let tmp = tempfile::tempdir().unwrap();
            let p = tmp.path().join("config.json");
            std::fs::write(&p, "old").unwrap();
            chmod(&p, 0o644);
            write_private_file(&p, b"secret\n").unwrap();
            assert_eq!(std::fs::read_to_string(&p).unwrap(), "secret\n");
            assert_eq!(mode(&p), 0o600);
            assert_eq!(names(tmp.path()), vec!["config.json"]);
            assert_owner_only(&p, file_opts()).unwrap();
        }

        #[test]
        fn write_private_file_leaves_no_temp_file_when_the_rename_fails() {
            let tmp = tempfile::tempdir().unwrap();
            let p = tmp.path().join("adir");
            std::fs::create_dir_all(p.join("child")).unwrap();
            assert!(write_private_file(&p, b"x").is_err());
            assert_eq!(names(tmp.path()), vec!["adir"]);
        }

        #[test]
        fn mkdir_private_creates_parents_and_chmods_0700_also_an_existing_0755_dir() {
            let tmp = tempfile::tempdir().unwrap();
            let d = tmp.path().join("a").join("b");
            mkdir_private(&d).unwrap();
            assert_eq!(mode(&d), 0o700);
            chmod(&d, 0o755);
            mkdir_private(&d).unwrap();
            assert_eq!(mode(&d), 0o700);
        }

        #[test]
        fn mkdir_private_refuses_a_symlink_without_chmodding_its_target() {
            let tmp = tempfile::tempdir().unwrap();
            let target = tmp.path().join("target");
            std::fs::create_dir(&target).unwrap();
            chmod(&target, 0o755);
            let link = tmp.path().join("link");
            symlink(&target, &link).unwrap();
            let r = refusal(mkdir_private(&link));
            assert_eq!(
                r.message,
                format!("{} is a symlink; refusing to use it", link.display())
            );
            assert_eq!(mode(&target), 0o755);
        }

        #[test]
        fn refuses_a_group_other_readable_file_with_the_chmod_hint() {
            let tmp = tempfile::tempdir().unwrap();
            let p = tmp.path().join("machine.json");
            std::fs::write(&p, "{}").unwrap();
            chmod(&p, 0o644);
            let r = refusal(assert_owner_only(&p, file_opts()));
            assert_eq!(r.reason, AclRefusal::TooOpen);
            let d = p.display();
            assert_eq!(
                r.message,
                format!("{d} is readable by other users; run: chmod 600 {d}")
            );
            assert_owner_only(
                &p,
                AssertOwnerOnlyOptions {
                    kind: AclKind::File,
                    check_access: false,
                },
            )
            .unwrap();
        }

        #[test]
        fn never_mode_checks_a_dir() {
            let tmp = tempfile::tempdir().unwrap();
            chmod(tmp.path(), 0o755);
            assert_owner_only(tmp.path(), dir_opts()).unwrap();
        }

        #[test]
        fn refuses_symlinks_and_the_wrong_kind_with_the_credential_messages() {
            let tmp = tempfile::tempdir().unwrap();
            let f = tmp.path().join("f");
            std::fs::write(&f, "").unwrap();
            chmod(&f, 0o600);
            let link = tmp.path().join("link");
            symlink(&f, &link).unwrap();
            let r = refusal(assert_owner_only(&link, file_opts()));
            assert_eq!(
                r.message,
                format!("{} is a symlink; refusing to use it", link.display())
            );
            assert_eq!(r.reason, AclRefusal::WrongType);
            assert_eq!(
                refusal(assert_owner_only(&f, dir_opts())).message,
                format!("{} is not a directory", f.display())
            );
            assert_eq!(
                refusal(assert_owner_only(tmp.path(), file_opts())).message,
                format!("{} is not a regular file", tmp.path().display())
            );
        }

        #[test]
        fn refuses_a_path_owned_by_another_uid() {
            let tmp = tempfile::tempdir().unwrap();
            let f = tmp.path().join("f");
            std::fs::write(&f, "").unwrap();
            chmod(&f, 0o600);
            let uid = std::fs::metadata(&f).unwrap().uid();
            for (p, kind) in [(f.as_path(), AclKind::File), (tmp.path(), AclKind::Dir)] {
                let r = refusal(super::super::imp::assert_posix_as(
                    p,
                    AssertOwnerOnlyOptions::new(kind),
                    uid + 1,
                ));
                assert_eq!(r.reason, AclRefusal::ForeignOwner);
                assert_eq!(
                    r.message,
                    format!(
                        "{} is owned by another user; refusing to use it",
                        p.display()
                    )
                );
            }
        }

        #[test]
        fn a_missing_path_is_not_found() {
            let tmp = tempfile::tempdir().unwrap();
            match assert_owner_only(&tmp.path().join("nope"), dir_opts()) {
                Err(PrivateError::Io(e)) => assert_eq!(e.kind(), std::io::ErrorKind::NotFound),
                other => panic!("{other:?}"),
            }
        }

        #[test]
        fn current_user_sid_is_win32_only() {
            assert!(current_user_sid().unwrap_err().message.contains("win32"));
        }
    }

    #[cfg(windows)]
    mod win32 {
        use super::*;
        use crate::platform::fs::tests_support::make_junction;
        use std::path::PathBuf;

        fn icacls(args: &[&str]) -> bool {
            let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
            std::process::Command::new(format!("{root}\\System32\\icacls.exe"))
                .args(args)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .is_ok_and(|s| s.success())
        }

        /// A temp dir made private first (%TEMP% is not owner-only; it exists, so nothing is
        /// created under a non-private parent).
        fn private_tmp() -> tempfile::TempDir {
            let tmp = tempfile::tempdir().unwrap();
            mkdir_private(tmp.path()).unwrap();
            tmp
        }

        fn s(p: &Path) -> String {
            p.to_string_lossy().into_owned()
        }

        #[test]
        fn current_user_sid_is_a_user_sid() {
            let sid = current_user_sid().unwrap();
            assert!(sid.starts_with("S-1-5-21-") && is_sid(&sid), "{sid}");
            assert_eq!(current_user_sid().unwrap(), sid);
        }

        #[test]
        fn a_file_written_by_write_private_file_passes_and_holds_the_data() {
            let tmp = private_tmp();
            let p = tmp.path().join("machine.json");
            write_private_file(&p, b"secret\n").unwrap();
            assert_eq!(std::fs::read_to_string(&p).unwrap(), "secret\n");
            assert_eq!(names(tmp.path()), vec!["machine.json"]);
            assert_owner_only(&p, file_opts()).unwrap();
            // Replacing it keeps it private.
            write_private_file(&p, b"secret2\n").unwrap();
            assert_eq!(std::fs::read_to_string(&p).unwrap(), "secret2\n");
            assert_owner_only(&p, file_opts()).unwrap();
        }

        #[test]
        fn refuses_a_plain_inheriting_file() {
            let tmp = private_tmp();
            let p = tmp.path().join("plain.json");
            std::fs::write(&p, "{}").unwrap();
            // Owned by Administrators when the test runs elevated (the Actions runner).
            let r = refusal(assert_owner_only(&p, file_opts()));
            assert!(
                matches!(r.reason, AclRefusal::Inherited | AclRefusal::ForeignOwner),
                "{r:?}"
            );
            assert!(icacls(&[
                &s(&p),
                "/setowner",
                &format!("*{}", current_user_sid().unwrap())
            ]));
            assert_eq!(
                refusal(assert_owner_only(&p, file_opts())).reason,
                AclRefusal::Inherited
            );
        }

        #[test]
        fn refuses_after_everyone_is_granted_read() {
            let tmp = private_tmp();
            let p = tmp.path().join("machine.json");
            write_private_file(&p, b"secret").unwrap();
            assert!(icacls(&[&s(&p), "/grant", &format!("*{EVERYONE}:R")]));
            let r = refusal(assert_owner_only(&p, file_opts()));
            assert_eq!(r.reason, AclRefusal::TooOpen);
            assert!(r.message.contains(&format!(
                "{} is accessible to other users ({EVERYONE})",
                p.display()
            )));
            assert!(r.message.contains("icacls"));
        }

        #[test]
        fn refuses_after_inheritance_is_re_enabled() {
            let tmp = private_tmp();
            let p = tmp.path().join("machine.json");
            write_private_file(&p, b"secret").unwrap();
            assert!(icacls(&[&s(&p), "/inheritance:e"]));
            assert_eq!(
                refusal(assert_owner_only(&p, file_opts())).reason,
                AclRefusal::Inherited
            );
        }

        #[test]
        fn refuses_a_file_owned_by_another_sid_when_the_runner_may_set_one() {
            let tmp = private_tmp();
            let p = tmp.path().join("machine.json");
            write_private_file(&p, b"secret").unwrap();
            if !icacls(&[&s(&p), "/setowner", &format!("*{SID_SYSTEM}")]) {
                eprintln!("skipped: not privileged; the evaluate_win_acl cases cover the decision");
                return;
            }
            let r = refusal(assert_owner_only(&p, file_opts()));
            assert_eq!(r.reason, AclRefusal::ForeignOwner);
            assert!(r.message.contains(&format!("({SID_SYSTEM})")));
        }

        #[test]
        fn mkdir_private_refuses_an_existing_dir_owned_by_another_sid() {
            let tmp = private_tmp();
            let d = tmp.path().join("foreign");
            std::fs::create_dir(&d).unwrap();
            if !icacls(&[&s(&d), "/setowner", &format!("*{SID_SYSTEM}")]) {
                eprintln!("skipped: not privileged");
                return;
            }
            let r = refusal(mkdir_private(&d));
            assert_eq!(r.reason, AclRefusal::ForeignOwner);
            assert_eq!(r.owner.as_deref(), Some(SID_SYSTEM));
        }

        #[test]
        fn mkdir_private_makes_an_owner_only_dir_whose_children_inherit_only_those_grants() {
            let tmp = private_tmp();
            let d = tmp.path().join("private").join("push-1");
            mkdir_private(&d).unwrap();
            assert_owner_only(&d, dir_opts()).unwrap();
            // A child created inside inherits only user/SYSTEM/Administrators (and so is refused
            // as inheriting until it is restricted itself).
            let child = d.join("child");
            std::fs::write(&child, "x").unwrap();
            let acl = read_win_acl(&child).unwrap();
            assert!(!acl.rules.is_empty());
            let user = current_user_sid().unwrap();
            for r in &acl.rules {
                assert!(r.inherited, "{r:?}");
                let sid = r.sid.to_uppercase();
                assert!(
                    [user.as_str(), SID_SYSTEM, SID_ADMINISTRATORS].contains(&sid.as_str()),
                    "{sid}"
                );
            }
            let r = refusal(assert_owner_only(&child, file_opts()));
            assert!(matches!(
                r.reason,
                AclRefusal::Inherited | AclRefusal::ForeignOwner
            ));
            // write_private_file inside it passes.
            let f = d.join("cred.json");
            write_private_file(&f, b"x").unwrap();
            assert_owner_only(&f, file_opts()).unwrap();
        }

        #[test]
        fn refuses_a_junction_and_a_missing_path_fails_closed() {
            let tmp = private_tmp();
            let target = tmp.path().join("target");
            std::fs::create_dir(&target).unwrap();
            let link = tmp.path().join("junction");
            make_junction(&link, &target);
            assert_eq!(refusal(mkdir_private(&link)).reason, AclRefusal::WrongType);
            assert!(assert_owner_only(&tmp.path().join("nope"), file_opts()).is_err());
        }

        #[test]
        fn handles_paths_with_spaces_metacharacters_and_brackets() {
            let tmp = private_tmp();
            let d = tmp.path().join("a b & [c] %x% $y");
            mkdir_private(&d).unwrap();
            assert_owner_only(&d, dir_opts()).unwrap();
            let f = d.join("it's.json");
            write_private_file(&f, b"x").unwrap();
            assert_owner_only(&f, file_opts()).unwrap();
        }

        #[test]
        fn write_private_file_refuses_a_folder_that_is_not_private_creating_nothing() {
            let plain = tempfile::tempdir().unwrap();
            let p = plain.path().join("machine.json");
            let r = refusal(write_private_file(&p, b"secret"));
            // Inheriting; or owned by Administrators when the runner is elevated.
            assert!(matches!(
                r.reason,
                AclRefusal::Inherited | AclRefusal::ForeignOwner
            ));
            assert!(r.message.contains(&format!(
                "refusing to write {}: its folder is not private",
                p.display()
            )));
            assert!(names(plain.path()).is_empty());
        }

        #[test]
        fn mkdir_private_refuses_to_create_under_a_non_private_ancestor_creating_nothing() {
            let plain = tempfile::tempdir().unwrap();
            let d = plain.path().join("a").join("b");
            let r = refusal(mkdir_private(&d));
            assert!(matches!(
                r.reason,
                AclRefusal::Inherited | AclRefusal::ForeignOwner
            ));
            assert!(r.message.contains(&format!(
                "refusing to create {}: {} is not private",
                d.display(),
                plain.path().display()
            )));
            assert!(!plain.path().join("a").exists());
        }

        fn unique(prefix: &str) -> String {
            format!(
                "{prefix}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            )
        }

        #[test]
        fn mkdir_private_creates_directly_under_localappdata_every_level_owner_only() {
            let base = PathBuf::from(std::env::var_os("LOCALAPPDATA").expect("LOCALAPPDATA"));
            let top = base.join(unique("conductor-acl-test"));
            let r = std::panic::catch_unwind(|| {
                let d = top.join("private").join("push-1");
                mkdir_private(&d).unwrap();
                for level in [top.clone(), top.join("private"), d.clone()] {
                    assert_owner_only(&level, dir_opts()).unwrap();
                }
                write_private_file(&d.join("cred.json"), b"x").unwrap();
            });
            let _ = std::fs::remove_dir_all(&top);
            if let Err(e) = r {
                std::panic::resume_unwind(e);
            }
        }

        #[test]
        #[allow(deprecated)] // std::env::home_dir on older toolchains
        fn mkdir_private_creates_directly_under_the_profile_dir() {
            let top = std::env::home_dir()
                .unwrap()
                .join(unique(".conductor-acl-test"));
            let r = std::panic::catch_unwind(|| {
                mkdir_private(&top).unwrap();
                assert_owner_only(&top, dir_opts()).unwrap();
            });
            let _ = std::fs::remove_dir_all(&top);
            if let Err(e) = r {
                std::panic::resume_unwind(e);
            }
        }

        #[test]
        fn a_real_owner_only_acl_has_matching_sddl_ace_count_and_rules() {
            let tmp = private_tmp();
            let f = tmp.path().join("x.json");
            write_private_file(&f, b"x").unwrap();
            let acl = read_win_acl(&f).unwrap();
            assert_eq!(acl.ace_count, 3);
            assert_eq!(acl.rules.len(), 3);
            let types: Vec<String> = parse_sddl(&acl.sddl)
                .unwrap()
                .aces
                .into_iter()
                .map(|a| a.ace_type)
                .collect();
            assert_eq!(types, vec!["A", "A", "A"]);
        }
    }
}
