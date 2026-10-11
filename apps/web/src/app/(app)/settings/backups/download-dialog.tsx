"use client";

import { useState, useTransition } from "react";
import { TextField } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { prepareBackupDownloadAction } from "./moss-actions";

/** Download a MOSS backup: a fresh two-factor code, and a passphrase the archive is encrypted with. */
export function DownloadMossBackup({ name }: { name: string }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [pending, start] = useTransition();

  return (
    <Dialog open={open} onOpenChange={(o) => (setOpen(o), setError(""))}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          Download
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Download {name}</DialogTitle>
          <DialogDescription>
            It holds MOSS&apos;s master key, so it&apos;s encrypted with a passphrase you choose. Keep the passphrase somewhere other than the file: restore.sh
            asks for it, and without it the backup can&apos;t be opened.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            setError("");
            start(async () => {
              const r = await prepareBackupDownloadAction(name, form);
              if (r.error || !r.ticket) return setError(r.error ?? "Something went wrong.");
              window.location.assign(`/api/moss-backups/download?ticket=${encodeURIComponent(r.ticket)}`);
              setOpen(false);
            });
          }}
        >
          <TextField label="Passphrase" name="passphrase" type="password" autoComplete="new-password" minLength={12} required hint="At least 12 characters." />
          <TextField label="Passphrase again" name="confirm" type="password" autoComplete="new-password" required />
          <TextField label="Authenticator code" name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={7} required />
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" disabled={pending}>
            {pending ? "Checking…" : "Download encrypted"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
