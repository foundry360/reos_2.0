"use client";

import { useEffect, useState, type InputHTMLAttributes } from "react";
import { ExtensionSafeInput } from "@/components/shell/extension-safe-input";
import {
  formatPhoneInput,
  phoneInputFromStored,
} from "@/lib/phone-display";

interface PhoneInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type"> {
  name: string;
  value?: string | null;
  onChange?: (displayValue: string) => void;
}

export function PhoneInput({
  name,
  value = "",
  onChange,
  className,
  placeholder = "555-123-4567",
  disabled,
  id,
  ...rest
}: PhoneInputProps) {
  const [display, setDisplay] = useState(() => phoneInputFromStored(value));

  useEffect(() => {
    setDisplay(phoneInputFromStored(value));
  }, [value]);

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const formatted = formatPhoneInput(e.target.value);
    setDisplay(formatted);
    onChange?.(formatted);
  }

  return (
    <>
      <ExtensionSafeInput
        {...rest}
        id={id}
        className={className}
        type="tel"
        inputMode="numeric"
        autoComplete="tel"
        value={display}
        onChange={handleChange}
        placeholder={placeholder}
        disabled={disabled}
      />
      <input type="hidden" name={name} value={display} />
    </>
  );
}
