import { BasementView } from "@/components/basement/basement-view";
import { BasementFurniture } from "@/components/basement/furniture";
import { DESKS } from "@/components/basement/layout";
import { LiveRefresh } from "@/components/live-refresh";
import { PageHeader } from "@/components/page";
import { requireUser } from "@/server/auth";
import { basement } from "@/server/queries";

export const metadata = { title: "The Basement" };

export default async function BasementPage() {
  const user = await requireUser();
  const b = await basement(user.orgId);
  const alarm = b.down.length > 0;
  const working = b.team.filter((a) => a.working || (alarm && a.id === b.responderId)).length;

  return (
    <>
      <PageHeader
        title="The Basement"
        description="What your agents are doing right now. Updates every 15 seconds."
        actions={
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 font-mono text-[13px]">
            <span className="flex items-center gap-2 text-phosphor">
              <span aria-hidden className="size-2.5 bg-phosphor" />
              {working} working
            </span>
            <span className="flex items-center gap-2 text-muted-foreground">
              <span aria-hidden className="size-2.5 bg-muted-foreground" />
              {b.team.length - working} on break
            </span>
            <span className="flex items-center gap-2 text-muted-foreground">
              <span aria-hidden className="size-2.5 border-2 border-muted-foreground" />
              {Math.max(0, DESKS.length - working)} free desks
            </span>
            <span className={`flex items-center gap-2 ${alarm ? "text-alarm" : "text-phosphor"}`}>
              <span aria-hidden className={`size-2.5 ${alarm ? "bg-alarm" : "bg-phosphor"}`} />
              {alarm ? `${b.down.length} monitor${b.down.length === 1 ? "" : "s"} down` : "All monitors up"}
            </span>
          </div>
        }
      />
      <LiveRefresh everyMs={15_000} />
      <BasementView team={b.team} down={b.down} responderId={b.responderId} seed={Math.floor(Math.random() * 1_000_000)} furniture={<BasementFurniture alarm={alarm} />} />
    </>
  );
}
