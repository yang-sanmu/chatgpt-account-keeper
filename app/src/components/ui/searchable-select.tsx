import * as React from "react";
import { Button } from "./button";
import { Input } from "./input";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import { Check, ChevronsUpDown } from "lucide-react";

interface SearchableSelectProps {
  value: string;
  onValueChange: (value: string) => void;
  options: { value: string; label: string }[];
  label: string;
  id?: string;
  className?: string;
}

export function SearchableSelect({ value, onValueChange, options, label, id, className }: SearchableSelectProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const input = React.useRef<HTMLInputElement>(null);
  const list = React.useRef<HTMLDivElement>(null);
  const listId = React.useId();
  const keywords = query.trim().toLocaleLowerCase().split(/\s+/);
  const matches = options.filter((option) => keywords.every((part) => option.label.toLocaleLowerCase().includes(part)));

  const select = (next: string) => {
    onValueChange(next);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); setQuery(""); }}>
      <PopoverTrigger asChild>
        <Button type="button" id={id} variant="outline" role="combobox" aria-label={label}
          aria-expanded={open} aria-controls={listId} className={className ?? "w-full justify-between"}>
          <span className="truncate">{options.find((option) => option.value === value)?.label ?? label}</span>
          <ChevronsUpDown className="ml-2 size-4 shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="p-2 w-[max(16rem,var(--radix-popover-trigger-width))]" align="start"
        onOpenAutoFocus={(event) => { event.preventDefault(); input.current?.focus(); }}>
        <Input ref={input} aria-label={`搜索${label}`} placeholder={`搜索${label}...`}
          value={query} onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === "Enter") {
              event.preventDefault();
              if (matches[0]) select(matches[0].value);
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              list.current?.querySelector<HTMLButtonElement>('[role="option"]')?.focus();
            }
          }} />
        <div ref={list} id={listId} role="listbox" aria-label={label} className="mt-2 max-h-60 overflow-y-auto">
          {matches.map((option) => (
            <button type="button" role="option" aria-selected={option.value === value} key={option.value}
              className="flex w-full items-center rounded px-2 py-2 text-left text-sm hover:bg-sunken focus:bg-sunken"
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  (event.currentTarget.nextElementSibling as HTMLElement | null)?.focus();
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  ((event.currentTarget.previousElementSibling as HTMLElement | null) ?? input.current)?.focus();
                }
              }}
              onClick={() => select(option.value)}>
              <span className="flex-1">{option.label}</span>
              {option.value === value && <Check className="size-4" />}
            </button>
          ))}
          {!matches.length && <p className="p-2 text-sm text-muted">没有匹配项</p>}
        </div>
      </PopoverContent>
    </Popover>
  );
}
