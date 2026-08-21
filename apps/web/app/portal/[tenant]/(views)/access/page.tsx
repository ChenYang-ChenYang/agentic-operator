"use client";

/**
 * Access & roles (P6-AUTH) — the user-permission management tab.
 *
 * Two-level view:
 *   - "Members": the active tenant's members (admins + superadmins). Add an
 *     existing user by email, change role, remove. Driven by /v1/members.
 *   - "All users": platform-wide (superadmin only). Set platform role, suspend,
 *     and grant/revoke any user's access to any tenant. Driven by /v1/admin/users.
 *
 * Authorization is enforced server-side; this page mirrors it for UX (the nav
 * item is hidden for non-admins, and this page renders a no-access state as a
 * defensive fallback).
 */

import { useMemo, useState } from "react";
import { PASSWORD_MIN } from "@agentic/contracts";
import type { AdminUserRow, MemberRow, TenantRole } from "@agentic/contracts";
import { Badge, Button, Empty, ViewHeader } from "@/app/portal/components";
import { toast } from "@/app/portal/components/toast";
import { useI18n } from "@/app/portal/lib/preferences-context";
import { useMe } from "@/lib/hooks/useMe";
import { useTenants } from "@/lib/hooks/useTenants";
import {
  useAddMember,
  useAdminUsers,
  useCreateUser,
  useDeleteUser,
  useGrantMembership,
  useMembers,
  useRemoveMember,
  useRevokeMembership,
  useUpdateMemberRole,
  useUpdateUser,
} from "@/lib/hooks/useAccess";
import { formatApiError } from "@/lib/api-response";

const ROLES: TenantRole[] = ["admin", "operator", "viewer"];

function roleLabel(t: (k: string) => string, role: TenantRole): string {
  return t(`access.role${role[0]!.toUpperCase()}${role.slice(1)}`);
}

export default function AccessPage() {
  const { t } = useI18n();
  const meQuery = useMe();
  const me = meQuery.data;
  const caps = me?.capabilities ?? [];
  const canRead = caps.includes("members.read");
  const canManage = caps.includes("members.write");
  const isSuper = me?.user.platformRole === "superadmin";

  const [tab, setTab] = useState<"members" | "users">("members");
  const [addOpen, setAddOpen] = useState(false);

  if (meQuery.isLoading) {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
        <ViewHeader title={t("nav.access")} subtitle={t("access.subtitle")} />
        <Empty title={t("access.loading")} />
      </div>
    );
  }

  if (meQuery.isError || !me) {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
        <ViewHeader title={t("nav.access")} subtitle={t("access.subtitle")} />
        <Empty
          title={t("access.loadFailed")}
          hint={formatApiError(meQuery.error, t, "access.apiUnreachable")}
        />
      </div>
    );
  }

  if (!canRead) {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
        <ViewHeader title={t("nav.access")} subtitle={t("access.subtitle")} />
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Empty
            title={t("access.noAccessTitle")}
            hint={t("access.noAccessHint")}
          />
        </div>
      </div>
    );
  }

  const activeTab = isSuper ? tab : "members";

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <ViewHeader
        title={t("nav.access")}
        subtitle={t("access.subtitle")}
        action={
          activeTab === "members" && canManage ? (
            <Button
              tone="primary"
              small
              icon="plus"
              onClick={() => setAddOpen(true)}
            >
              {t("access.addMember")}
            </Button>
          ) : null
        }
      />

      {isSuper ? (
        <div
          style={{
            display: "flex",
            gap: 4,
            padding: "10px 24px 0",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <TabButton
            active={activeTab === "members"}
            onClick={() => setTab("members")}
          >
            {t("access.tabMembers")}
          </TabButton>
          <TabButton
            active={activeTab === "users"}
            onClick={() => setTab("users")}
          >
            {t("access.tabAllUsers")}
          </TabButton>
        </div>
      ) : null}

      <div style={{ flex: 1, overflow: "auto", padding: "18px 24px" }}>
        {activeTab === "members" ? (
          <MembersView canManage={canManage} selfId={me?.user.id ?? null} />
        ) : (
          <AllUsersView selfId={me?.user.id ?? null} />
        )}
      </div>

      {addOpen ? <AddMemberModal onClose={() => setAddOpen(false)} /> : null}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "8px 12px",
        background: "transparent",
        border: "none",
        borderBottom: `2px solid ${active ? "var(--signal)" : "transparent"}`,
        color: active ? "var(--text)" : "var(--text-3)",
        fontSize: 13,
        fontWeight: active ? 600 : 500,
        cursor: "pointer",
        marginBottom: -1,
      }}
    >
      {children}
    </button>
  );
}

// ─── Members (tenant-scoped) ─────────────────────────────────────────────────

function MembersView({
  canManage,
  selfId,
}: {
  canManage: boolean;
  selfId: string | null;
}) {
  const { language, t } = useI18n();
  const { data: members, isLoading, isError, error } = useMembers(true);
  const updateRole = useUpdateMemberRole();
  const removeMember = useRemoveMember();
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (members ?? []).filter(
      (m) =>
        !q ||
        m.email.toLowerCase().includes(q) ||
        m.name.toLowerCase().includes(q),
    );
  }, [members, query]);
  const adminCount = (members ?? []).filter(
    (member) => member.role === "admin",
  ).length;

  if (isError)
    return (
      <Empty
        title={t("access.loadFailed")}
        hint={formatApiError(error, t, "access.apiUnreachable")}
      />
    );
  if (isLoading) return <Empty title={t("access.loading")} />;
  if (!members || members.length === 0)
    return <Empty title={t("access.emptyMembers")} />;

  async function onRole(m: MemberRow, role: TenantRole) {
    try {
      await updateRole.mutateAsync({ userId: m.userId, role });
      toast({ tone: "signal", title: t("access.toastRoleChanged") });
    } catch (e) {
      toast({
        tone: "red",
        title: t("access.toastFailed"),
        description: formatApiError(e, t, "access.apiUnreachable"),
      });
    }
  }
  async function onRemove(m: MemberRow) {
    if (!window.confirm(t("access.removeConfirm", { name: m.name }))) return;
    try {
      await removeMember.mutateAsync(m.userId);
      toast({ tone: "signal", title: t("access.toastMemberRemoved") });
    } catch (e) {
      toast({
        tone: "red",
        title: t("access.toastFailed"),
        description: formatApiError(e, t, "access.apiUnreachable"),
      });
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <SearchBox
        value={query}
        onChange={setQuery}
        placeholder={t("access.searchPlaceholder")}
      />
      <Table
        head={[
          t("access.colMember"),
          t("access.colRole"),
          t("access.colJoined"),
          "",
        ]}
      >
        {filtered.map((m) => {
          const isSelf = m.userId === selfId;
          const isLastAdmin = m.role === "admin" && adminCount <= 1;
          const protectedReason = isSelf
            ? t("access.selfProtected")
            : isLastAdmin
              ? t("access.lastAdminProtected")
              : undefined;
          return (
            <tr key={m.userId} style={{ borderTop: "1px solid var(--border)" }}>
              <Cell>
                <MemberCell name={m.name} email={m.email} isSelf={isSelf} />
              </Cell>
              <Cell>
                {canManage ? (
                  <RoleSelect
                    value={m.role}
                    onChange={(r) => onRole(m, r)}
                    disabled={updateRole.isPending || Boolean(protectedReason)}
                    title={protectedReason}
                  />
                ) : (
                  <Badge tone="muted">{roleLabel(t, m.role)}</Badge>
                )}
              </Cell>
              <Cell muted>{fmtDate(m.createdAt, language)}</Cell>
              <Cell align="right">
                {canManage ? (
                  <Button
                    tone="danger"
                    small
                    onClick={() => onRemove(m)}
                    disabled={
                      removeMember.isPending || Boolean(protectedReason)
                    }
                    title={protectedReason}
                  >
                    {t("access.remove")}
                  </Button>
                ) : null}
              </Cell>
            </tr>
          );
        })}
      </Table>
    </div>
  );
}

/**
 * Admin-provisioned account (POST /v1/admin/users).
 *
 * The initial tenant grant is offered here rather than left to a second step:
 * an account created without one can sign in but lands on the "request access"
 * empty state, which users reliably report as "my login is broken".
 *
 * The password is set by the admin and is usable immediately — there is no
 * invite/activation email yet — so the copy tells them to hand it over as a
 * temporary credential the user changes in Settings → Account.
 */
function CreateUserModal({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const createUser = useCreateUser();
  const tenantsQuery = useTenants();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [platformRole, setPlatformRole] = useState<"none" | "superadmin">(
    "none",
  );
  const [tenantSlug, setTenantSlug] = useState("");
  const [role, setRole] = useState<TenantRole>("viewer");
  const [error, setError] = useState<string | null>(null);

  // Same shape + archived filter the grant-membership modal uses: offering an
  // archived tenant would create a grant the user can never act on.
  const tenantOptions = (tenantsQuery.data?.items ?? []).filter(
    (tn) => tn.archivedAt == null,
  );
  const tooShort = password.length > 0 && password.length < PASSWORD_MIN;
  const canSubmit =
    Boolean(email.trim()) &&
    Boolean(name.trim()) &&
    password.length >= PASSWORD_MIN &&
    !createUser.isPending;

  async function submit() {
    setError(null);
    try {
      await createUser.mutateAsync({
        email: email.trim().toLowerCase(),
        name: name.trim(),
        password,
        platformRole,
        ...(tenantSlug ? { membership: { tenantSlug, role } } : {}),
      });
      toast({ tone: "signal", title: t("access.toastUserCreated") });
      onClose();
    } catch (e) {
      setError(formatApiError(e, t, "access.apiUnreachable"));
    }
  }

  return (
    <Modal title={t("access.newUserTitle")} onClose={onClose}>
      <p style={{ fontSize: 12, color: "var(--text-3)", marginTop: 0 }}>
        {t("access.newUserHint")}
      </p>
      <LabeledInput
        label={t("access.emailLabel")}
        value={email}
        onChange={setEmail}
        placeholder={t("access.emailPlaceholder")}
        type="email"
      />
      <LabeledInput
        label={t("access.nameLabel")}
        value={name}
        onChange={setName}
        placeholder={t("access.namePlaceholder")}
      />
      <LabeledInput
        label={t("access.tempPasswordLabel")}
        value={password}
        onChange={setPassword}
        placeholder={t("access.tempPasswordPlaceholder")}
        type="password"
        revealLabels={{
          show: t("auth.showPassword"),
          hide: t("auth.hidePassword"),
        }}
      />
      <div style={{ fontSize: 11, color: tooShort ? "var(--red)" : "var(--text-4)" }}>
        {t("access.passwordMinHint", { min: PASSWORD_MIN })}
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 6,
          marginTop: 12,
        }}
      >
        <span style={{ fontSize: 11.5, color: "var(--text-2)" }}>
          {t("access.initialAccessLabel")}
        </span>
        <div style={{ display: "flex", gap: 8 }}>
          <select
            value={tenantSlug}
            onChange={(e) => setTenantSlug(e.target.value)}
            style={{ ...selectStyle, flex: 1 }}
            aria-label={t("access.tenantLabel")}
          >
            <option value="">{t("access.noInitialTenant")}</option>
            {tenantOptions.map((tn) => (
              <option key={tn.slug} value={tn.slug}>
                {tn.name} ({tn.slug})
              </option>
            ))}
          </select>
          {tenantSlug ? <RoleSelect value={role} onChange={setRole} /> : null}
        </div>
        <span style={{ fontSize: 11, color: "var(--text-4)" }}>
          {tenantSlug
            ? t("access.initialAccessHint")
            : t("access.noInitialTenantHint")}
        </span>
      </div>
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginTop: 12,
          fontSize: 12,
          color: "var(--text-2)",
        }}
      >
        <input
          type="checkbox"
          checked={platformRole === "superadmin"}
          onChange={(e) =>
            setPlatformRole(e.target.checked ? "superadmin" : "none")
          }
        />
        {t("access.makeSuperadmin")}
      </label>
      {error ? <ErrorNote text={error} /> : null}
      <ModalActions>
        <Button tone="ghost" small onClick={onClose}>
          {t("access.cancel")}
        </Button>
        <Button tone="primary" small onClick={submit} disabled={!canSubmit}>
          {createUser.isPending ? t("access.creating") : t("access.create")}
        </Button>
      </ModalActions>
    </Modal>
  );
}

function AddMemberModal({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const addMember = useAddMember();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<TenantRole>("viewer");
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    try {
      await addMember.mutateAsync({ email: email.trim().toLowerCase(), role });
      toast({ tone: "signal", title: t("access.toastMemberAdded") });
      onClose();
    } catch (e) {
      setError(formatApiError(e, t, "access.apiUnreachable"));
    }
  }

  return (
    <Modal title={t("access.addMemberTitle")} onClose={onClose}>
      <p style={{ fontSize: 12, color: "var(--text-3)", marginTop: 0 }}>
        {t("access.addMemberHint")}
      </p>
      <LabeledInput
        label={t("access.emailLabel")}
        value={email}
        onChange={setEmail}
        placeholder={t("access.emailPlaceholder")}
        type="email"
      />
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 6,
          marginTop: 12,
        }}
      >
        <span style={{ fontSize: 11.5, color: "var(--text-2)" }}>
          {t("access.roleLabel")}
        </span>
        <RoleSelect value={role} onChange={setRole} />
        <span style={{ fontSize: 11, color: "var(--text-4)" }}>
          {t(`access.roleHint${role[0]!.toUpperCase()}${role.slice(1)}`)}
        </span>
      </div>
      {error ? <ErrorNote text={error} /> : null}
      <ModalActions>
        <Button tone="ghost" small onClick={onClose}>
          {t("access.cancel")}
        </Button>
        <Button
          tone="primary"
          small
          onClick={submit}
          disabled={addMember.isPending || !email}
        >
          {addMember.isPending ? t("access.adding") : t("access.add")}
        </Button>
      </ModalActions>
    </Modal>
  );
}

// ─── All users (platform superadmin) ─────────────────────────────────────────

function AllUsersView({ selfId }: { selfId: string | null }) {
  const { t } = useI18n();
  const { data: users, isLoading, isError, error } = useAdminUsers(true);
  const updateUser = useUpdateUser();
  const deleteUser = useDeleteUser();
  const [query, setQuery] = useState("");
  const [manage, setManage] = useState<AdminUserRow | null>(null);
  const [resetting, setResetting] = useState<AdminUserRow | null>(null);
  const [creating, setCreating] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (users ?? []).filter(
      (u) =>
        !q ||
        u.email.toLowerCase().includes(q) ||
        u.name.toLowerCase().includes(q),
    );
  }, [users, query]);
  const superadminCount = (users ?? []).filter(
    (user) => user.platformRole === "superadmin",
  ).length;

  if (isError)
    return (
      <Empty
        title={t("access.loadFailed")}
        hint={formatApiError(error, t, "access.apiUnreachable")}
      />
    );
  if (isLoading) return <Empty title={t("access.loading")} />;
  if (!users || users.length === 0)
    return <Empty title={t("access.emptyUsers")} />;

  async function patch(
    u: AdminUserRow,
    body: {
      platformRole?: "none" | "superadmin";
      status?: "active" | "suspended";
      password?: string;
    },
  ) {
    try {
      await updateUser.mutateAsync({ userId: u.id, ...body });
      toast({ tone: "signal", title: t("access.toastUserUpdated") });
    } catch (e) {
      toast({
        tone: "red",
        title: t("access.toastFailed"),
        description: formatApiError(e, t, "access.apiUnreachable"),
      });
    }
  }

  async function onDelete(u: AdminUserRow) {
    if (
      !window.confirm(
        t("access.deleteUserConfirm", { name: u.name, email: u.email }),
      )
    )
      return;
    try {
      await deleteUser.mutateAsync(u.id);
      toast({ tone: "signal", title: t("access.toastUserDeleted") });
    } catch (e) {
      toast({
        tone: "red",
        title: t("access.toastFailed"),
        description: formatApiError(e, t, "access.apiUnreachable"),
      });
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <SearchBox
            value={query}
            onChange={setQuery}
            placeholder={t("access.searchPlaceholder")}
          />
        </div>
        <Button tone="primary" small onClick={() => setCreating(true)}>
          {t("access.newUser")}
        </Button>
      </div>
      {creating && <CreateUserModal onClose={() => setCreating(false)} />}
      <Table
        head={[
          t("access.colMember"),
          t("access.colPlatform"),
          t("access.colTenants"),
          t("access.colStatus"),
          "",
        ]}
      >
        {filtered.map((u) => {
          const isSelf = u.id === selfId;
          const isLastSuperadmin =
            u.platformRole === "superadmin" && superadminCount <= 1;
          const platformRoleLock = isSelf
            ? t("access.selfProtected")
            : isLastSuperadmin
              ? t("access.lastSuperadminProtected")
              : undefined;
          return (
            <tr key={u.id} style={{ borderTop: "1px solid var(--border)" }}>
              <Cell>
                <MemberCell
                  name={u.name}
                  email={u.email}
                  isSelf={u.id === selfId}
                />
              </Cell>
              <Cell>
                {u.platformRole === "superadmin" ? (
                  <Badge tone="signal">{t("access.platformSuperadmin")}</Badge>
                ) : (
                  <span style={{ color: "var(--text-4)", fontSize: 12 }}>
                    {t("access.platformNone")}
                  </span>
                )}
              </Cell>
              <Cell>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                  {u.memberships.length === 0 ? (
                    <span style={{ color: "var(--text-4)", fontSize: 11.5 }}>
                      {t("access.notMember")}
                    </span>
                  ) : (
                    u.memberships.map((m) => (
                      <span
                        key={m.tenantSlug}
                        title={`${m.tenantName} · ${m.role}`}
                        style={{
                          fontSize: 10.5,
                          fontFamily: "var(--mono)",
                          padding: "2px 6px",
                          borderRadius: 4,
                          background: "var(--panel-2)",
                          border: "1px solid var(--border)",
                          color: "var(--text-2)",
                        }}
                      >
                        {m.tenantSlug}:{m.role}
                      </span>
                    ))
                  )}
                </div>
              </Cell>
              <Cell>
                <Badge tone={u.status === "active" ? "green" : "muted"}>
                  {t(
                    u.status === "active"
                      ? "access.statusActive"
                      : "access.statusSuspended",
                  )}
                </Badge>
              </Cell>
              <Cell align="right">
                <div style={{ display: "inline-flex", gap: 6 }}>
                  <Button tone="default" small onClick={() => setManage(u)}>
                    {t("access.manageMemberships")}
                  </Button>
                  <Button
                    tone="default"
                    small
                    disabled={updateUser.isPending}
                    onClick={() => setResetting(u)}
                  >
                    {t("access.resetPassword")}
                  </Button>
                  <Button
                    tone="default"
                    small
                    disabled={updateUser.isPending || Boolean(platformRoleLock)}
                    title={platformRoleLock}
                    onClick={() =>
                      patch(u, {
                        platformRole:
                          u.platformRole === "superadmin"
                            ? "none"
                            : "superadmin",
                      })
                    }
                  >
                    {u.platformRole === "superadmin"
                      ? t("access.demoteSuperadmin")
                      : t("access.promoteSuperadmin")}
                  </Button>
                  <Button
                    tone={u.status === "active" ? "danger" : "default"}
                    small
                    disabled={updateUser.isPending || isSelf}
                    title={isSelf ? t("access.selfProtected") : undefined}
                    onClick={() =>
                      patch(u, {
                        status: u.status === "active" ? "suspended" : "active",
                      })
                    }
                  >
                    {u.status === "active"
                      ? t("access.suspend")
                      : t("access.activate")}
                  </Button>
                  <Button
                    tone="danger"
                    small
                    disabled={deleteUser.isPending || isSelf}
                    title={isSelf ? t("access.selfProtected") : undefined}
                    onClick={() => onDelete(u)}
                  >
                    {t("access.deleteUser")}
                  </Button>
                </div>
              </Cell>
            </tr>
          );
        })}
      </Table>
      {manage ? (
        <ManageMembershipsModal
          user={manage}
          selfId={selfId}
          onClose={() => setManage(null)}
        />
      ) : null}
      {resetting ? (
        <ResetPasswordModal
          user={resetting}
          onReset={(password) => patch(resetting, { password })}
          pending={updateUser.isPending}
          onClose={() => setResetting(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * Admin password reset (PATCH /v1/admin/users/:id with `password`).
 *
 * Distinct from Settings → Account: that path proves the current password,
 * this one does not — it is a superadmin acting on someone else's account, so
 * the server audits it and the new value is only ever a temporary credential.
 * The field reveals on demand because the admin has to read the value back to
 * the person it belongs to.
 */
function ResetPasswordModal({
  user,
  onReset,
  pending,
  onClose,
}: {
  user: AdminUserRow;
  onReset: (password: string) => Promise<void>;
  pending: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [password, setPassword] = useState("");
  const tooShort = password.length > 0 && password.length < PASSWORD_MIN;
  const canSubmit = password.length >= PASSWORD_MIN && !pending;

  async function submit() {
    if (!canSubmit) return;
    await onReset(password);
    onClose();
  }

  return (
    <Modal title={t("access.resetPasswordTitle", { name: user.name })} onClose={onClose}>
      <p style={{ fontSize: 12, color: "var(--text-3)", marginTop: 0 }}>
        {t("access.resetPasswordHint")}
      </p>
      <LabeledInput
        label={t("access.resetPasswordLabel")}
        value={password}
        onChange={setPassword}
        placeholder={t("access.resetPasswordPlaceholder")}
        type="password"
        revealLabels={{
          show: t("auth.showPassword"),
          hide: t("auth.hidePassword"),
        }}
      />
      <div style={{ fontSize: 11, color: tooShort ? "var(--red)" : "var(--text-4)" }}>
        {t("access.passwordMinHint", { min: PASSWORD_MIN })}
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          gap: 8,
          marginTop: 18,
        }}
      >
        <Button tone="default" onClick={onClose}>
          {t("access.cancel")}
        </Button>
        <Button tone="primary" disabled={!canSubmit} onClick={submit}>
          {pending ? t("access.resetPasswordBusy") : t("access.resetPasswordSubmit")}
        </Button>
      </div>
    </Modal>
  );
}

function ManageMembershipsModal({
  user,
  selfId,
  onClose,
}: {
  user: AdminUserRow;
  selfId: string | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const tenantsQuery = useTenants();
  const usersQuery = useAdminUsers(true);
  const tenantsData = tenantsQuery.data;
  const liveUsers = usersQuery.data;
  const grant = useGrantMembership();
  const revoke = useRevokeMembership();
  const [tenantSlug, setTenantSlug] = useState("");
  const [role, setRole] = useState<TenantRole>("viewer");

  // Re-read the live row so the list updates after grant/revoke without closing.
  const current = liveUsers?.find((u) => u.id === user.id) ?? user;
  const tenantOptions = (tenantsData?.items ?? []).filter(
    (tn) => tn.archivedAt == null,
  );

  async function onGrant() {
    if (!tenantSlug) return;
    try {
      await grant.mutateAsync({ userId: user.id, tenantSlug, role });
      toast({ tone: "signal", title: t("access.toastUserUpdated") });
      setTenantSlug("");
    } catch (e) {
      toast({
        tone: "red",
        title: t("access.toastFailed"),
        description: formatApiError(e, t, "access.apiUnreachable"),
      });
    }
  }
  async function onRevoke(slug: string) {
    try {
      await revoke.mutateAsync({ userId: user.id, tenantSlug: slug });
      toast({ tone: "signal", title: t("access.toastUserUpdated") });
    } catch (e) {
      toast({
        tone: "red",
        title: t("access.toastFailed"),
        description: formatApiError(e, t, "access.apiUnreachable"),
      });
    }
  }

  return (
    <Modal
      title={t("access.manageMembershipsFor", { name: current.name })}
      onClose={onClose}
    >
      {tenantsQuery.isError || usersQuery.isError ? (
        <ErrorNote
          text={
            tenantsQuery.error
              ? formatApiError(tenantsQuery.error, t, "access.apiUnreachable")
              : formatApiError(usersQuery.error, t, "access.apiUnreachable")
          }
        />
      ) : null}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {current.memberships.length === 0 ? (
          <span style={{ color: "var(--text-4)", fontSize: 12 }}>
            {t("access.notMember")}
          </span>
        ) : (
          current.memberships.map((m) => (
            <div
              key={m.tenantSlug}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "6px 10px",
                background: "var(--panel-2)",
                border: "1px solid var(--border)",
                borderRadius: 6,
              }}
            >
              <span style={{ fontSize: 12.5, color: "var(--text)" }}>
                {m.tenantName}{" "}
                <span
                  style={{
                    color: "var(--text-3)",
                    fontFamily: "var(--mono)",
                    fontSize: 11,
                  }}
                >
                  · {roleLabel(t, m.role)}
                </span>
              </span>
              <Button
                tone="danger"
                small
                onClick={() => onRevoke(m.tenantSlug)}
                disabled={revoke.isPending || user.id === selfId}
                title={
                  user.id === selfId ? t("access.selfProtected") : undefined
                }
              >
                {t("access.revoke")}
              </Button>
            </div>
          ))
        )}
      </div>

      <div
        style={{ height: 1, background: "var(--border)", margin: "14px 0" }}
      />

      <div style={{ fontSize: 11.5, color: "var(--text-2)", marginBottom: 8 }}>
        {t("access.grantTenant")}
      </div>
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "flex-end",
          flexWrap: "wrap",
        }}
      >
        <label
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            flex: 1,
            minWidth: 140,
          }}
        >
          <span style={{ fontSize: 11, color: "var(--text-3)" }}>
            {t("access.tenantLabel")}
          </span>
          <select
            value={tenantSlug}
            onChange={(e) => setTenantSlug(e.target.value)}
            style={selectStyle}
          >
            <option value="">—</option>
            {tenantOptions.map((tn) => (
              <option key={tn.slug} value={tn.slug}>
                {tn.name} ({tn.slug})
              </option>
            ))}
          </select>
        </label>
        <label
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            minWidth: 120,
          }}
        >
          <span style={{ fontSize: 11, color: "var(--text-3)" }}>
            {t("access.roleLabel")}
          </span>
          <RoleSelect value={role} onChange={setRole} />
        </label>
        <Button
          tone="primary"
          small
          onClick={onGrant}
          disabled={!tenantSlug || grant.isPending}
        >
          {t("access.grant")}
        </Button>
      </div>

      <ModalActions>
        <Button tone="ghost" small onClick={onClose}>
          {t("access.close")}
        </Button>
      </ModalActions>
    </Modal>
  );
}

// ─── Small shared primitives ─────────────────────────────────────────────────

const selectStyle: React.CSSProperties = {
  padding: "7px 9px",
  background: "var(--panel-2)",
  border: "1px solid var(--border-2)",
  borderRadius: 6,
  color: "var(--text)",
  fontSize: 12.5,
  outline: "none",
};

function RoleSelect({
  value,
  onChange,
  disabled,
  title,
}: {
  value: TenantRole;
  onChange: (r: TenantRole) => void;
  disabled?: boolean;
  title?: string;
}) {
  const { t } = useI18n();
  return (
    <select
      value={value}
      disabled={disabled}
      title={title}
      onChange={(e) => onChange(e.target.value as TenantRole)}
      style={selectStyle}
    >
      {ROLES.map((r) => (
        <option key={r} value={r}>
          {roleLabel(t, r)}
        </option>
      ))}
    </select>
  );
}

function MemberCell({
  name,
  email,
  isSelf,
}: {
  name: string;
  email: string;
  isSelf: boolean;
}) {
  const { t } = useI18n();
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <span
        style={{
          width: 26,
          height: 26,
          borderRadius: "50%",
          background: "var(--panel-3)",
          border: "1px solid var(--border-2)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 10.5,
          color: "var(--text-2)",
          fontWeight: 600,
          flexShrink: 0,
        }}
      >
        {name.trim().slice(0, 2).toUpperCase()}
      </span>
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontSize: 13,
            color: "var(--text)",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          {name}
          {isSelf ? (
            <span
              style={{
                fontSize: 9.5,
                color: "var(--text-4)",
                fontFamily: "var(--mono)",
              }}
            >
              ({t("access.you")})
            </span>
          ) : null}
        </div>
        <div
          style={{
            fontSize: 11,
            color: "var(--text-3)",
            fontFamily: "var(--mono)",
          }}
        >
          {email}
        </div>
      </div>
    </div>
  );
}

function Table({
  head,
  children,
}: {
  head: string[];
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 8,
        overflow: "hidden",
        background: "var(--panel)",
      }}
    >
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            {head.map((h, i) => (
              <th
                key={i}
                style={{
                  textAlign: i === head.length - 1 ? "right" : "left",
                  padding: "10px 14px",
                  fontSize: 10.5,
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  color: "var(--text-4)",
                  fontWeight: 600,
                  background: "var(--panel-2)",
                }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function Cell({
  children,
  muted,
  align,
}: {
  children: React.ReactNode;
  muted?: boolean;
  align?: "right";
}) {
  return (
    <td
      style={{
        padding: "10px 14px",
        fontSize: 12.5,
        color: muted ? "var(--text-3)" : "var(--text-2)",
        textAlign: align ?? "left",
        verticalAlign: "middle",
      }}
    >
      {children}
    </td>
  );
}

function SearchBox({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      style={{
        ...selectStyle,
        maxWidth: 280,
        background: "var(--panel)",
      }}
    />
  );
}

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: "var(--z-modal)",
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 460,
          maxWidth: "90vw",
          background: "var(--panel)",
          border: "1px solid var(--border-2)",
          borderRadius: 12,
          padding: 22,
          boxShadow: "0 12px 40px rgba(0,0,0,0.45)",
        }}
      >
        <h2
          style={{
            margin: "0 0 14px",
            fontSize: 17,
            fontFamily: "var(--display)",
            fontWeight: 400,
            color: "var(--text)",
          }}
        >
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}

function ModalActions({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "flex-end",
        gap: 8,
        marginTop: 18,
      }}
    >
      {children}
    </div>
  );
}

/**
 * Labelled text input. Passing `revealLabels` turns it into a password field
 * with a show/hide toggle — an admin typing a credential they must then read
 * out needs to confirm it, and a masked-only field turns every typo into a
 * failed sign-in for someone else.
 */
function LabeledInput({
  label,
  value,
  onChange,
  placeholder,
  type,
  revealLabels,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  revealLabels?: { show: string; hide: string };
}) {
  const [revealed, setRevealed] = useState(false);
  const canReveal = Boolean(revealLabels);
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={{ fontSize: 11.5, color: "var(--text-2)" }}>{label}</span>
      <span style={{ position: "relative", display: "block" }}>
        <input
          type={canReveal && revealed ? "text" : (type ?? "text")}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          style={{
            ...selectStyle,
            background: "var(--panel-2)",
            width: "100%",
            ...(canReveal ? { paddingRight: 40 } : null),
          }}
        />
        {canReveal ? (
          <button
            type="button"
            tabIndex={-1}
            onClick={() => setRevealed((v) => !v)}
            aria-pressed={revealed}
            aria-label={revealed ? revealLabels!.hide : revealLabels!.show}
            title={revealed ? revealLabels!.hide : revealLabels!.show}
            style={{
              position: "absolute",
              top: "50%",
              right: 6,
              transform: "translateY(-50%)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 28,
              height: 28,
              padding: 0,
              background: "transparent",
              border: "none",
              borderRadius: 5,
              color: "var(--text-3)",
              cursor: "pointer",
            }}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z" />
              <circle cx="12" cy="12" r="3" />
              {revealed ? <path d="m4 4 16 16" /> : null}
            </svg>
          </button>
        ) : null}
      </span>
    </label>
  );
}

function ErrorNote({ text }: { text: string }) {
  return (
    <div
      role="alert"
      style={{
        marginTop: 12,
        fontSize: 12,
        color: "var(--red)",
        background: "color-mix(in srgb, var(--red) 10%, transparent)",
        border: "1px solid color-mix(in srgb, var(--red) 30%, transparent)",
        borderRadius: 6,
        padding: "8px 10px",
      }}
    >
      {text}
    </div>
  );
}

function fmtDate(ms: number, language: "en" | "zh"): string {
  if (!ms) return "—";
  try {
    return new Date(ms).toLocaleDateString(
      language === "zh" ? "zh-CN" : "en-US",
    );
  } catch {
    return "—";
  }
}
