import {
  LinearBacklogIcon,
  LinearCanceledIcon,
  LinearDoneIcon,
  LinearInProgressIcon,
  LinearInReviewIcon,
  LinearTodoIcon,
} from "./icons";
import { Select, cx, type SelectProps } from "./ui";
import type { SVGProps } from "react";

export const TASK_STATUS_OPTIONS = [
  { value: "backlog", label: "Backlog" },
  { value: "ready", label: "To-do" },
  { value: "in_progress", label: "In progress" },
  { value: "blocked", label: "Blocked" },
  { value: "review", label: "In review" },
  { value: "done", label: "Done" },
  { value: "cancelled", label: "Canceled" },
] as const;

export type TaskStatus = (typeof TASK_STATUS_OPTIONS)[number]["value"];

export const TASK_STATUS_VALUES = TASK_STATUS_OPTIONS.map((status) => status.value);

function knownTaskStatus(status: string): TaskStatus | undefined {
  return TASK_STATUS_VALUES.find((value) => value === status);
}

export function taskStatusLabel(status: string) {
  return (
    TASK_STATUS_OPTIONS.find((option) => option.value === status)?.label ??
    status.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase())
  );
}

export function TaskStatusIcon({
  status,
  size = 20,
  className,
  strokeWidth,
  ...props
}: Omit<SVGProps<SVGSVGElement>, "status"> & { status: string; size?: number }) {
  const normalizedStatus = knownTaskStatus(status);
  const Icon =
    normalizedStatus === "backlog"
      ? LinearBacklogIcon
      : normalizedStatus === "in_progress"
        ? LinearInProgressIcon
        : normalizedStatus === "review"
          ? LinearInReviewIcon
          : normalizedStatus === "done"
            ? LinearDoneIcon
            : normalizedStatus === "cancelled"
              ? LinearCanceledIcon
              : LinearTodoIcon;

  return (
    <Icon
      {...props}
      aria-hidden={props["aria-label"] ? undefined : true}
      className={cx("task-status-icon", `is-${normalizedStatus ?? "unknown"}`, className)}
      size={size}
      strokeWidth={strokeWidth === undefined ? undefined : String(strokeWidth)}
    />
  );
}

export function TaskStatusDisplay({
  status,
  className,
  iconSize = 16,
}: {
  status: string;
  className?: string;
  iconSize?: number;
}) {
  return (
    <span className={cx("task-status-display", className)}>
      <TaskStatusIcon status={status} size={iconSize} />
      <span>{taskStatusLabel(status)}</span>
    </span>
  );
}

export function TaskStatusSelect({
  ...props
}: Omit<SelectProps, "children" | "renderOption" | "renderValue" | "searchable">) {
  const renderStatus = (status: { value: string }) => (
    <TaskStatusDisplay status={status.value} iconSize={18} />
  );

  return (
    <Select {...props} searchable={false} renderOption={renderStatus} renderValue={renderStatus}>
      {TASK_STATUS_OPTIONS.map((status) => (
        <option key={status.value} value={status.value}>
          {status.label}
        </option>
      ))}
    </Select>
  );
}
