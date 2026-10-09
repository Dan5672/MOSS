"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

/** A page-header button that opens a form in a dialog, instead of the form taking up the page. */
export function FormDialog({
  label,
  title,
  description,
  children,
  wide = false,
  defaultOpen = false,
}: {
  label: string;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  wide?: boolean;
  /** Open on arrival, e.g. when another page links here to add something. */
  defaultOpen?: boolean;
}) {
  return (
    <Dialog defaultOpen={defaultOpen}>
      <DialogTrigger asChild>
        <Button>{label}</Button>
      </DialogTrigger>
      <DialogContent className={wide ? "max-h-[90vh] overflow-y-auto sm:max-w-3xl" : "max-h-[90vh] overflow-y-auto sm:max-w-xl"}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}
