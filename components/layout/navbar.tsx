/* eslint-disable @next/next/no-img-element */
"use client";

import Link from "next/link";
import useScroll from "@/lib/hooks/use-scroll";
import { UserDropdown } from "./user-dropdown";
import useSWRImmutable from "swr/immutable";
import { Button } from "@/components/ui/button";
import {
  SignInDialog,
  useSignInDialog,
} from "@/components/layout/sign-in-dialog";
import { UserData } from "@/lib/types";
import { create } from "zustand";

type UserDataStore = {
  userData: UserData | null;
  setUserData: (userData: UserData | null) => void;
};

export const useUserDataStore = create<UserDataStore>((set) => ({
  userData: null,
  setUserData: (userData) => set(() => ({ userData: userData })),
}));

export default function Navbar() {
  const setUserData = useUserDataStore((s) => s.setUserData);

  const { data: userData, isLoading } = useSWRImmutable(
    "userData",
    async () => {
      try {
        const res = await fetch("/api/user");
        if (!res.ok) return null;
        const json = await res.json();
        const user = json.user;
        setUserData(user);
        return user;
      } catch {
        return null;
      }
    },
  );

  const setShowSignInDialog = useSignInDialog((s) => s.setOpen);
  const scrolled = useScroll(50);

  return (
    <>
      <SignInDialog />
      <div
        className={`fixed top-0 w-full ${
          scrolled
            ? "border-b border-black/[0.06] bg-white/80 shadow-sm backdrop-blur-xl"
            : "border-b border-transparent bg-white/40 backdrop-blur-md"
        } z-30 transition-all duration-200`}
      >
        <div className="mx-5 flex h-16 max-w-screen-xl items-center justify-between xl:mx-auto">
          <Link href="/" className="flex items-center gap-2.5 font-display text-2xl group">
            <img
              src="/logo.png"
              alt="Extrapolate AI Logo"
              width="191"
              height="191"
              className="size-7 rounded-lg shadow-sm transition-transform duration-200 group-hover:scale-105"
            />
            <span className="font-bold tracking-tight text-neutral-900">Extrapolate</span>
            <span className="rounded-full border border-black/10 bg-neutral-100 px-2 py-0.5 text-[10px] font-semibold text-neutral-600">
              AI 2.0
            </span>
          </Link>
          <div>
            {userData ? (
              <UserDropdown userData={userData} />
            ) : (
              !isLoading && (
                <Button
                  size="sm"
                  className="rounded-full border border-primary transition-all hover:bg-primary-foreground hover:text-primary"
                  onClick={() => setShowSignInDialog(true)}
                >
                  Sign In
                </Button>
              )
            )}
          </div>
        </div>
      </div>
    </>
  );
}
