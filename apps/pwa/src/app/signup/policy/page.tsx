import { AuthLayout } from "@/components/auth/AuthLayout";
import { SignupStepPolicy } from "@/components/auth/SignupStepPolicy";

export default function SignupPolicyPage() {
  return (
    <AuthLayout title="Set your policy" step={3} totalSteps={5}>
      <SignupStepPolicy />
    </AuthLayout>
  );
}
