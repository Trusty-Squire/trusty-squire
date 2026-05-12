import { AuthLayout } from "@/components/auth/AuthLayout";
import { SignupStepConnect } from "@/components/auth/SignupStepConnect";

export default function SignupConnectPage() {
  return (
    <AuthLayout title="Connect your coding agent" step={4} totalSteps={4}>
      <SignupStepConnect />
    </AuthLayout>
  );
}
