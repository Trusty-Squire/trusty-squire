import { AuthLayout } from "@/components/auth/AuthLayout";
import { SignupStepSign } from "@/components/auth/SignupStepSign";

export default function SignupSignPage() {
  return (
    <AuthLayout title="Review and sign" step={3} totalSteps={4}>
      <SignupStepSign />
    </AuthLayout>
  );
}
