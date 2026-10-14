import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronRight, CornerDownRight, Table2, X } from "lucide-react";
import type { SnapshotOption } from "./schema.js";
import {
  researchTree,
  researchOrigin,
  visibleResearchNodes,
  type ResearchNode,
} from "./research-tree.js";
import { Button } from "./ui.js";

export function ResearchTreePanel({
  snapshots,
  currentId,
  onClose,
  onSelect,
}: {
  snapshots: SnapshotOption[];
  currentId: string;
  onClose: () => void;
  onSelect: (id: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const items = useRef(new Map<string, HTMLLIElement>());
  const [focusedId, setFocusedId] = useState(currentId);
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const roots = useMemo(() => researchTree(snapshots), [snapshots]);
  const visible = visibleResearchNodes(roots, collapsed);
  useLayoutEffect(() => {
    const element = dialog.current!;
    element.showModal();
    items.current.get(currentId)?.focus();
    return () => element.close();
  }, []);
  function focus(id: string) {
    setFocusedId(id);
    items.current.get(id)?.focus();
  }
  function toggle(id: string) {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    focus(id);
  }
  function render(nodes: ResearchNode[], level = 1, parentId?: string) {
    return nodes.map(({ snapshot, children }) => {
      const origin = researchOrigin(snapshot);
      const expanded = children.length
        ? !collapsed.has(snapshot.id)
        : undefined;
      return (
        <li
          key={snapshot.id}
          ref={(element) => {
            if (element) items.current.set(snapshot.id, element);
            else items.current.delete(snapshot.id);
          }}
          role="treeitem"
          aria-label={snapshot.title}
          aria-description={origin}
          aria-level={level}
          aria-selected={snapshot.id === currentId}
          aria-expanded={expanded}
          tabIndex={focusedId === snapshot.id ? 0 : -1}
          onFocus={(event) => {
            if (event.target === event.currentTarget) setFocusedId(snapshot.id);
          }}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            const index = visible.findIndex(
              (n) => n.snapshot.id === snapshot.id,
            );
            const key = event.key;
            if (
              ![
                "ArrowDown",
                "ArrowUp",
                "ArrowLeft",
                "ArrowRight",
                "Home",
                "End",
                "Enter",
                " ",
              ].includes(key)
            )
              return;
            event.preventDefault();
            event.stopPropagation();
            if (key === "Enter" || key === " ") onSelect(snapshot.id);
            else if (key === "ArrowRight") {
              if (expanded === false) toggle(snapshot.id);
              else if (children.length) focus(children[0].snapshot.id);
            } else if (key === "ArrowLeft") {
              if (expanded) toggle(snapshot.id);
              else if (parentId) focus(parentId);
            } else {
              const next =
                key === "Home"
                  ? 0
                  : key === "End"
                    ? visible.length - 1
                    : Math.max(
                        0,
                        Math.min(
                          visible.length - 1,
                          index + (key === "ArrowDown" ? 1 : -1),
                        ),
                      );
              focus(visible[next].snapshot.id);
            }
          }}
        >
          <div
            className="research-tree-row"
            title={origin ? `${snapshot.title}\n${origin}` : snapshot.title}
            style={{ paddingLeft: 6 + Math.min(level - 1, 6) * 18 }}
            onClick={() => onSelect(snapshot.id)}
          >
            {children.length ? (
              <button
                type="button"
                tabIndex={-1}
                className="tree-disclosure"
                aria-label={`${expanded ? "Collapse" : "Expand"} ${snapshot.title}`}
                onClick={(event) => {
                  event.stopPropagation();
                  toggle(snapshot.id);
                }}
              >
                <ChevronRight
                  className={expanded ? "expanded" : ""}
                  aria-hidden="true"
                />
              </button>
            ) : (
              <span className="tree-leaf-icon">
                {level === 1 ? (
                  <Table2 aria-hidden="true" />
                ) : (
                  <CornerDownRight aria-hidden="true" />
                )}
              </span>
            )}
            <span className="tree-node-label">
              <span>{snapshot.title}</span>
              <small>
                {origin ?? (
                  <time dateTime={snapshot.capturedAt}>
                    {snapshot.capturedAt}
                  </time>
                )}
              </small>
            </span>
            {snapshot.id === currentId && (
              <Check className="tree-current" aria-hidden="true" />
            )}
          </div>
          {expanded && (
            <ul role="group">{render(children, level + 1, snapshot.id)}</ul>
          )}
        </li>
      );
    });
  }
  return (
    <dialog
      ref={dialog}
      id="research-tree-panel"
      className="research-tree-dialog"
      aria-labelledby="research-tree-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") event.stopPropagation();
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const box = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < box.left ||
          event.clientX > box.right ||
          event.clientY < box.top ||
          event.clientY > box.bottom
        )
          onClose();
      }}
    >
      <div className="research-tree-heading">
        <h2 id="research-tree-title">Research tree</h2>
        <Button
          variant="ghost"
          aria-label="Close research tree"
          onClick={onClose}
        >
          <X />
        </Button>
      </div>
      <div className="research-tree-content">
        <ul role="tree" aria-label="Saved research hierarchy">
          {render(roots)}
        </ul>
      </div>
    </dialog>
  );
}
