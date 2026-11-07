import { useMemo } from "react";
import { ProjectIconMark } from "./ProjectIconMark";
import { parseProjectIcon } from "./project-icons";

/**
 * A repository's BB project icon as Cursor Sidebar draws it (glyph, emoji,
 * monogram or uploaded image), or the folder when none is set.
 */
export function RepoIcon({ icon, className = "size-3.5" }: { icon: string | null | undefined; className?: string }) {
  const parsed = useMemo(() => (icon ? parseProjectIcon(icon) : null), [icon]);
  return (
    <ProjectIconMark
      icon={parsed}
      fallback="Folder"
      className={className}
      mutedClassName="text-[color:var(--bbs-text-tertiary)]"
    />
  );
}
