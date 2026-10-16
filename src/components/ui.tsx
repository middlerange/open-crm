import {
  CheckIcon,
  ChevronDownIcon,
  CloseIcon as X,
  EyeHideIcon,
  EyeIcon,
  SearchIcon,
} from "./icons";
import {
  Children,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";

export function cx(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

export function Button({
  variant = "secondary",
  size = "medium",
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "plain" | "danger";
  size?: "small" | "medium" | "icon";
}) {
  return (
    <button className={cx("button", `button-${variant}`, `button-${size}`, className)} {...props}>
      {children}
    </button>
  );
}

const FieldLabelContext = createContext<string | undefined>(undefined);

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  const fieldLabelId = useContext(FieldLabelContext);
  return (
    <input
      {...props}
      aria-labelledby={props["aria-label"] ? undefined : (props["aria-labelledby"] ?? fieldLabelId)}
      className={cx("input", props.className)}
    />
  );
}

export function PasswordInput(props: Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  const [visible, setVisible] = useState(false);
  const fieldLabelId = useContext(FieldLabelContext);
  return (
    <span className="password-control">
      <input
        {...props}
        type={visible ? "text" : "password"}
        aria-labelledby={
          props["aria-label"] ? undefined : (props["aria-labelledby"] ?? fieldLabelId)
        }
        className={cx("input", props.className)}
      />
      <button
        type="button"
        aria-label={visible ? "Hide password" : "Show password"}
        aria-pressed={visible}
        onClick={() => setVisible((current) => !current)}
      >
        {visible ? <EyeHideIcon size={16} /> : <EyeIcon size={16} />}
      </button>
    </span>
  );
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const fieldLabelId = useContext(FieldLabelContext);
  return (
    <textarea
      {...props}
      aria-labelledby={props["aria-label"] ? undefined : (props["aria-labelledby"] ?? fieldLabelId)}
      className={cx("input", "textarea", props.className)}
    />
  );
}

export type SelectOption = {
  disabled: boolean;
  label: string;
  value: string;
};

export type SelectProps = {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  searchable?: boolean;
  placeholder?: string;
  id?: string;
  required?: boolean;
  renderOption?: (option: SelectOption) => ReactNode;
  renderValue?: (option: SelectOption) => ReactNode;
  "aria-label"?: string;
  "aria-labelledby"?: string;
};

function nodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  return Children.toArray(node).map(nodeText).join("");
}

function selectOptions(children: ReactNode): SelectOption[] {
  return Children.toArray(children).flatMap((child) => {
    if (
      !isValidElement<{ children?: ReactNode; disabled?: boolean; value?: string | number }>(child)
    ) {
      return [];
    }
    if (child.type === "option") {
      return [
        {
          disabled: Boolean(child.props.disabled),
          label: nodeText(child.props.children),
          value: String(child.props.value ?? ""),
        },
      ];
    }
    if (child.type === "optgroup") return selectOptions(child.props.children);
    return [];
  });
}

export function Select({
  value,
  defaultValue = "",
  onValueChange,
  children,
  className,
  disabled = false,
  searchable,
  placeholder = "Select an option",
  id,
  required,
  renderOption,
  renderValue,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
}: SelectProps) {
  const fieldLabelId = useContext(FieldLabelContext);
  const generatedId = useId();
  const listboxId = `${generatedId}-listbox`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [internalValue, setInternalValue] = useState(defaultValue);
  const [position, setPosition] = useState({ left: 8, top: 8, width: 250 });
  const options = useMemo(() => selectOptions(children), [children]);
  const currentValue = value ?? internalValue;
  const selected = options.find((option) => option.value === currentValue);
  const useSearch = searchable ?? options.length > 7;
  const visibleOptions = options.filter((option) =>
    option.label.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const accessibleLabelledBy = ariaLabel ? undefined : (ariaLabelledBy ?? fieldLabelId);

  const close = useCallback((restoreFocus = true) => {
    setOpen(false);
    setQuery("");
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const width = Math.min(Math.max(rect.width, 250), window.innerWidth - 16);
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
    let top = rect.bottom + 6;
    const popoverHeight = popoverRef.current?.offsetHeight ?? 320;
    if (top + popoverHeight > window.innerHeight - 8 && rect.top > popoverHeight + 14) {
      top = rect.top - popoverHeight - 6;
    }
    setPosition({ left, top: Math.max(8, top), width });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    const frame = requestAnimationFrame(() => {
      updatePosition();
      if (useSearch) {
        searchRef.current?.focus();
      } else {
        const selectedOption = popoverRef.current?.querySelector<HTMLElement>(
          '[role="option"][aria-selected="true"]',
        );
        const firstOption = popoverRef.current?.querySelector<HTMLElement>('[role="option"]');
        (selectedOption ?? firstOption)?.focus();
      }
    });
    const reposition = () => updatePosition();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open, updatePosition, useSearch]);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      close(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [close, open]);

  function choose(nextValue: string) {
    if (value === undefined) setInternalValue(nextValue);
    onValueChange?.(nextValue);
    close();
  }

  function moveOption(current: HTMLElement, direction: 1 | -1) {
    const items = [...(popoverRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
    const currentIndex = items.indexOf(current);
    items[(currentIndex + direction + items.length) % items.length]?.focus();
  }

  const popover = open ? (
    <div
      ref={popoverRef}
      className="select-popover"
      style={{ left: position.left, top: position.top, width: position.width }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
    >
      {useSearch ? (
        <div className="select-search">
          <SearchIcon size={15} />
          <input
            ref={searchRef}
            aria-label="Search options"
            autoComplete="off"
            placeholder="Search…"
            role="searchbox"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "ArrowDown") return;
              event.preventDefault();
              popoverRef.current?.querySelector<HTMLElement>('[role="option"]')?.focus();
            }}
          />
        </div>
      ) : null}
      <div className="select-options" id={listboxId} role="listbox">
        {visibleOptions.length ? (
          visibleOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              className="select-option"
              role="option"
              aria-selected={option.value === currentValue}
              disabled={option.disabled}
              onClick={() => choose(option.value)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  moveOption(event.currentTarget, event.key === "ArrowDown" ? 1 : -1);
                } else if (event.key === "Home" || event.key === "End") {
                  event.preventDefault();
                  const items = [
                    ...(popoverRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? []),
                  ];
                  items[event.key === "Home" ? 0 : items.length - 1]?.focus();
                }
              }}
            >
              <span className="select-option-content">
                {renderOption?.(option) ?? option.label}
              </span>
              <CheckIcon
                className={cx("select-option-check", option.value === currentValue && "is-visible")}
                size={15}
              />
            </button>
          ))
        ) : (
          <div className="select-empty">No results</div>
        )}
      </div>
    </div>
  ) : null;

  return (
    <span className="select-shell">
      <button
        ref={triggerRef}
        id={id}
        type="button"
        className={cx("button", "button-secondary", "select-trigger", className)}
        role="combobox"
        aria-controls={listboxId}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        aria-labelledby={accessibleLabelledBy}
        aria-required={required || undefined}
        disabled={disabled || options.length === 0}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (["ArrowDown", "ArrowUp"].includes(event.key)) {
            event.preventDefault();
            setOpen(true);
          } else if (event.key === "Escape" && open) {
            event.preventDefault();
            event.stopPropagation();
            close();
          }
        }}
      >
        <span className={cx("select-value", !selected && "is-placeholder")}>
          {selected ? (renderValue?.(selected) ?? selected.label) : placeholder}
        </span>
        <ChevronDownIcon className={cx("select-chevron", open && "is-open")} size={14} />
      </button>
      {popover && createPortal(popover, document.body)}
    </span>
  );
}

export function SearchInput({
  value,
  onChange,
  placeholder = "Search…",
  label = "Search",
  loading = false,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label?: string;
  loading?: boolean;
  className?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };

    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  return (
    <div className={cx("index-search", className)}>
      <span className="index-search-icon">{loading ? <Spinner /> : <SearchIcon size={15} />}</span>
      <input
        ref={inputRef}
        aria-label={label}
        autoComplete="off"
        autoCorrect="off"
        placeholder={placeholder}
        role="searchbox"
        spellCheck={false}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            if (value) onChange("");
            else inputRef.current?.blur();
          } else if (event.key === "Enter") {
            event.preventDefault();
          }
        }}
      />
      {value ? (
        <button
          type="button"
          className="index-search-clear"
          aria-label="Clear search"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            onChange("");
            inputRef.current?.focus();
          }}
        >
          <X size={14} />
        </button>
      ) : null}
    </div>
  );
}

export function PageToolbar({
  children,
  className,
  label = "Page tools",
}: {
  children: ReactNode;
  className?: string;
  label?: string;
}) {
  return (
    <div className={cx("page-toolbar", className)} role="region" aria-label={label}>
      {children}
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  const labelId = useId();
  const primary = Children.toArray(children).some(
    (child) => isValidElement<{ autoFocus?: boolean }>(child) && child.props.autoFocus,
  );
  return (
    <div className={cx("field", primary && "field-primary")}>
      <span className="field-label" id={labelId}>
        {label}
      </span>
      <FieldLabelContext.Provider value={labelId}>{children}</FieldLabelContext.Provider>
      {hint ? <span className="field-hint">{hint}</span> : null}
    </div>
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "blue" | "green" | "amber" | "red" | "purple";
}) {
  return <span className={cx("badge", `badge-${tone}`)}>{children}</span>;
}

export function Avatar({
  name,
  size = "medium",
}: {
  name: string;
  size?: "small" | "medium" | "large";
}) {
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
  return (
    <span className={cx("avatar", `avatar-${size}`)} aria-label={name}>
      {initials}
    </span>
  );
}

export function Panel({
  children,
  className,
  flush = false,
}: {
  children: ReactNode;
  className?: string;
  flush?: boolean;
}) {
  return <section className={cx("panel", flush && "panel-flush", className)}>{children}</section>;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </div>
  );
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  const titleId = useId();
  const descriptionId = useId();
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [
        ...dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ];
      if (!focusable.length) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handler);
    const frame = requestAnimationFrame(() => {
      const modalBody = dialogRef.current?.querySelector<HTMLElement>(".modal-body");
      const primaryControl = modalBody?.querySelector<HTMLElement>(
        '.field-primary input:not([type="hidden"]):not([disabled]), .field-primary select:not([disabled]), .field-primary textarea:not([disabled]), .field-primary button:not([disabled]), [autofocus]:not([disabled])',
      );
      const firstFormControl = modalBody?.querySelector<HTMLElement>(
        'form input:not([type="hidden"]):not([disabled]), form select:not([disabled]), form textarea:not([disabled]), form button:not([disabled])',
      );
      const firstBodyControl = modalBody?.querySelector<HTMLElement>(
        'input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), a[href]',
      );
      (primaryControl ?? firstFormControl ?? firstBodyControl ?? dialogRef.current)?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handler);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
  }, [open]);
  if (!open) return null;
  return (
    <div
      className="modal-layer"
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
      >
        <header className="modal-header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description ? <p id={descriptionId}>{description}</p> : null}
          </div>
          <Button
            type="button"
            variant="plain"
            size="icon"
            className="modal-close"
            aria-label="Close"
            onClick={onClose}
          >
            <X size={16} />
          </Button>
        </header>
        <div className="modal-body">{children}</div>
        {footer ? <footer className="modal-footer">{footer}</footer> : null}
      </section>
    </div>
  );
}

type Toast = { id: number; message: string; tone: "success" | "error" };
const ToastContext = createContext<{
  notify: (message: string, tone?: Toast["tone"]) => void;
} | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const notify = useCallback((message: string, tone: Toast["tone"] = "success") => {
    const id = Date.now();
    setToasts((current) => [...current, { id, message, tone }]);
    window.setTimeout(
      () => setToasts((current) => current.filter((toast) => toast.id !== id)),
      3200,
    );
  }, []);
  const value = useMemo(() => ({ notify }), [notify]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-region" aria-live="polite" aria-atomic="true">
        {toasts.map((toast) => (
          <div key={toast.id} className={cx("toast", `toast-${toast.tone}`)}>
            {toast.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast must be used inside ToastProvider.");
  return context;
}

export function Spinner() {
  return <span className="spinner" role="status" aria-label="Loading" />;
}
