"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import type { OrgCapability, OrgRole } from "@prisma/client";

import { signOutAction } from "@/app/login/actions";
import { orgNavGroups } from "@/lib/org-nav";

import { ThemeMenu } from "./theme";

export interface ShellOrganization {
  id: string;
  name: string;
  role: OrgRole;
}

/** Short switcher badge for staff roles; members show no badge. */
const ROLE_BADGE: Partial<Record<OrgRole, string>> = {
  ADMIN: "Admin",
  MANAGER: "Manager",
};

const PINNED_KEY = "sarbase-nav-pinned";
const NAV_EVENT = "sarbase-nav-pinned-change";
const LG_QUERY = "(min-width: 1024px)";

/** Sidebar pin state persisted in localStorage — read reactively. */
function useNavPinned(): [boolean, (v: boolean) => void] {
  const pinned = useSyncExternalStore(
    useCallback((notify) => {
      window.addEventListener(NAV_EVENT, notify);
      window.addEventListener("storage", notify);
      return () => {
        window.removeEventListener(NAV_EVENT, notify);
        window.removeEventListener("storage", notify);
      };
    }, []),
    () => window.localStorage.getItem(PINNED_KEY) !== "0",
    () => true,
  );
  const setPinned = useCallback((v: boolean) => {
    window.localStorage.setItem(PINNED_KEY, v ? "1" : "0");
    window.dispatchEvent(new Event(NAV_EVENT));
  }, []);
  return [pinned, setPinned];
}

/** Whether the lg breakpoint currently matches (desktop layout). */
function useIsLg(): boolean {
  return useSyncExternalStore(
    useCallback((notify) => {
      const mq = window.matchMedia(LG_QUERY);
      mq.addEventListener("change", notify);
      return () => mq.removeEventListener("change", notify);
    }, []),
    () => window.matchMedia(LG_QUERY).matches,
    () => false,
  );
}

function MenuIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      className="h-5 w-5"
    >
      <path d="M3 5h14M3 10h14M3 15h14" strokeLinecap="round" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      className="h-4 w-4"
    >
      <path d="M5 7.5l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * The organization workspace shell: a persistent, grouped sidebar on
 * desktop that collapses to a top-bar hamburger (the same overlay
 * drawer mobile always uses). Navigation visibility is role- and
 * capability-aware for UX only — every destination enforces its own
 * server-side grant.
 */
export function OrgShell({
  orgId,
  orgName,
  role,
  capabilities,
  organizations,
  children,
}: {
  orgId: string;
  orgName: string;
  role: OrgRole;
  capabilities: OrgCapability[];
  organizations: ShellOrganization[];
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const groups = orgNavGroups(orgId, capabilities, {
    isAdmin: role === "ADMIN",
    isStaff: role !== "MEMBER",
  });

  // Desktop pinning; below lg the sidebar is always the overlay drawer.
  const [pinned, setPinned] = useNavPinned();
  const isLg = useIsLg();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const drawerCloseRef = useRef<HTMLButtonElement>(null);
  const switcherRef = useRef<HTMLDivElement>(null);

  // Route change closes transient surfaces — a render-time reset
  // (React's "adjusting state during render" pattern), not an effect.
  const [prevPathname, setPrevPathname] = useState(pathname);
  if (prevPathname !== pathname) {
    setPrevPathname(pathname);
    setDrawerOpen(false);
    setSwitcherOpen(false);
  }

  // Drawer focus management + Escape.
  useEffect(() => {
    if (!drawerOpen) return;
    drawerCloseRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setDrawerOpen(false);
        menuButtonRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [drawerOpen]);

  // Switcher: click-outside + Escape.
  useEffect(() => {
    if (!switcherOpen) return;
    const onPointer = (e: MouseEvent) => {
      if (!switcherRef.current?.contains(e.target as Node)) {
        setSwitcherOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSwitcherOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [switcherOpen]);

  const isActive = (href: string) =>
    pathname === href || pathname.startsWith(`${href}/`);

  const nav = (
    <nav aria-label="Organization workspace" className="flex-1 overflow-y-auto">
      {groups.map((group) => (
        <div key={group.label} className="px-3 pb-4">
          <p className="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-neutral-400">
            {group.label}
          </p>
          <ul className="space-y-0.5">
            {group.items.map((item) => {
              const active = isActive(item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={`block rounded-md px-2 py-1.5 text-sm ${
                      active
                        ? "bg-neutral-900 font-medium text-white"
                        : "text-neutral-700 hover:bg-neutral-100"
                    }`}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      <div className="border-t border-neutral-200 px-3 py-3">
        <Link
          href="/account"
          className="block rounded-md px-2 py-1.5 text-sm text-neutral-700 hover:bg-neutral-100"
        >
          My account
        </Link>
        <div className="mt-2 flex gap-3 px-2 text-xs text-neutral-500">
          <Link href="/privacy" className="hover:underline">
            Privacy
          </Link>
          <Link href="/terms" className="hover:underline">
            Terms
          </Link>
        </div>
      </div>
    </nav>
  );

  const toggleNav = () => {
    if (isLg && pinned) {
      setPinned(false);
    } else {
      setDrawerOpen(true);
    }
  };
  const navVisible = drawerOpen || (isLg && pinned);

  return (
    <div className="min-h-screen">
      <a
        href="#content"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-neutral-900 focus:underline"
      >
        Skip to content
      </a>

      <header className="sticky top-0 z-30 flex h-12 items-center gap-3 border-b border-neutral-200 bg-white px-3 sm:px-4">
        <button
          ref={menuButtonRef}
          type="button"
          onClick={toggleNav}
          aria-label={
            navVisible ? "Hide navigation menu" : "Open navigation menu"
          }
          aria-expanded={navVisible}
          aria-haspopup={isLg && pinned ? undefined : "dialog"}
          className="rounded-md p-2 text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900"
        >
          <MenuIcon />
        </button>

        <div className="relative min-w-0" ref={switcherRef}>
          {organizations.length > 1 ? (
            <>
              <button
                type="button"
                onClick={() => setSwitcherOpen((v) => !v)}
                aria-expanded={switcherOpen}
                aria-haspopup="menu"
                className="flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm font-medium text-neutral-900 hover:bg-neutral-100"
              >
                <span className="truncate">{orgName}</span>
                <ChevronDownIcon />
              </button>
              {switcherOpen && (
                <ul
                  role="menu"
                  aria-label="Switch organization"
                  className="absolute left-0 top-full z-40 mt-1 w-64 rounded-md border border-neutral-200 bg-white py-1 shadow-lg"
                >
                  {organizations.map((org) => (
                    <li key={org.id} role="none">
                      <Link
                        role="menuitem"
                        href={`/org/${org.id}`}
                        aria-current={org.id === orgId ? "page" : undefined}
                        className={`flex items-center justify-between px-3 py-2 text-sm hover:bg-neutral-50 ${
                          org.id === orgId
                            ? "font-medium text-neutral-900"
                            : "text-neutral-700"
                        }`}
                      >
                        <span className="truncate">{org.name}</span>
                        {ROLE_BADGE[org.role] && (
                          <span className="ml-3 shrink-0 text-xs text-neutral-500">
                            {ROLE_BADGE[org.role]}
                          </span>
                        )}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <Link
              href={`/org/${orgId}`}
              className="block truncate rounded-md px-2 py-1 text-sm font-medium text-neutral-900 hover:bg-neutral-100"
            >
              {orgName}
            </Link>
          )}
        </div>

        <div className="ml-auto flex items-center gap-1">
          <ThemeMenu />
          <Link
            href="/account"
            className="hidden rounded-md px-2 py-1 text-sm text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 sm:block"
          >
            My account
          </Link>
          <form action={signOutAction}>
            <button
              type="submit"
              className="rounded-md px-2 py-1 text-sm text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900"
            >
              Sign out
            </button>
          </form>
        </div>
      </header>

      <div className="lg:flex">
        {pinned && (
          <aside className="sticky top-12 hidden h-[calc(100vh-3rem)] w-60 shrink-0 border-r border-neutral-200 bg-white lg:flex lg:flex-col">
            {nav}
          </aside>
        )}
        <main id="content" className="min-w-0 flex-1">
          {children}
        </main>
      </div>

      {drawerOpen && (
        <div
          className="fixed inset-0 z-50"
          role="dialog"
          aria-modal="true"
          aria-label="Navigation"
        >
          <div
            className="absolute inset-0 bg-scrim"
            onClick={() => setDrawerOpen(false)}
            aria-hidden="true"
          />
          <aside className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col bg-white shadow-xl">
            <div className="flex h-12 items-center justify-between border-b border-neutral-200 px-3">
              <span className="truncate px-2 text-sm font-medium text-neutral-900">
                {orgName}
              </span>
              <button
                ref={drawerCloseRef}
                type="button"
                onClick={() => {
                  setDrawerOpen(false);
                  menuButtonRef.current?.focus();
                }}
                aria-label="Close navigation menu"
                className="rounded-md p-2 text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900"
              >
                <svg
                  aria-hidden="true"
                  viewBox="0 0 20 20"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  className="h-5 w-5"
                >
                  <path d="M5 5l10 10M15 5L5 15" strokeLinecap="round" />
                </svg>
              </button>
            </div>
            {nav}
          </aside>
        </div>
      )}
    </div>
  );
}
