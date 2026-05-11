import { AuthLayout } from "@/components/auth/AuthLayout";
import { SignupStepSign } from "@/components/auth/SignupStepSign";

export default function SignupSignPage() {
  return (
    <AuthLayout title="Review and sign" step={4} totalSteps={5}>
      <SignupStepSign />
    </AuthLayout>
  );
}
