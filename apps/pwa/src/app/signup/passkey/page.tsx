import { AuthLayout } from "@/components/auth/AuthLayout";
import { SignupStepPasskey } from "@/components/auth/SignupStepPasskey";

export default function SignupPasskeyPage() {
  return (
    <AuthLayout title="Add a passkey" step={2} totalSteps={5}>
      <SignupStepPasskey />
    </AuthLayout>
  );
}
