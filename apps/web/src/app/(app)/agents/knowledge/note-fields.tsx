import { TextAreaField, TextField } from "@/components/field";

export function NoteFields({ note }: { note?: { title: string; body: string; subject: string | null; tags: string[] } }) {
  return (
    <>
      <TextField label="Title" name="title" maxLength={120} defaultValue={note?.title} required placeholder="ISP gateway" />
      <TextField label="Subject" name="subject" maxLength={120} defaultValue={note?.subject ?? ""} className="font-mono" placeholder="10.0.0.1" hint="Optional: the IP, hostname or service it's about." />
      <TextAreaField label="Note" name="body" rows={4} maxLength={4000} defaultValue={note?.body} required placeholder="The ISP's gateway. Its open ports are expected; don't report them." />
      <TextField label="Tags" name="tags" defaultValue={note?.tags.join(", ")} className="font-mono" placeholder="gateway, expected" hint="Optional, separated by commas." />
    </>
  );
}
